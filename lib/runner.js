// Copyright 2013 Pedro P. Candel <kusorbox@gmail.com> All rights reserved.

var assert = require('assert-plus');
var util = require('util');
var uuid = require('uuid');
var fs = require('fs');
var path = require('path');
var vasync = require('vasync');
var bunyan = require('bunyan');
var WorkflowJobRunner = require('./job-runner');
var Factory = require('../lib/index').Factory;
var exists = fs.exists || path.exists;
var trace_event = require('trace-event');

// - opts - configuration options:
//    - identifier: Unique identifier for this runner.
//    - forks: Max number of child processes to fork at the same time.
//    - run_interval: Check for new jobs every 'run_interval' milliseconds.
//                    (By default, every 250 milliseconds).
//    - sandbox: Collection of node modules to pass to the sandboxed tasks
//               execution. Object with the form:
//               {
//                  'module_global_var_name': 'node-module-name'
//               }
//               By default, only the global timeouts are passed to the tasks
//               sandbox.
var WorkflowRunner = module.exports = function (opts) {
    if (typeof (opts) !== 'object') {
        throw new TypeError('opts (Object) required');
    }

    if (typeof (opts.backend) !== 'object') {
        throw new TypeError('opts.backend (Object) required');
    }

    if (typeof (opts.dtrace) !== 'object') {
        throw new TypeError('opts.dtrace (Object) required');
    }

    if (typeof (opts.runner) !== 'object') {
        opts.runner = {};
    }

    // Make sure both are numeric:
    if (typeof (opts.runner.forks) !== 'number' || opts.runner.forks <= 1) {
        opts.runner.forks = 5;
    } else {
        opts.runner.forks = Math.round(opts.runner.forks);
    }

    if (typeof (opts.runner.run_interval) !== 'number' ||
        opts.runner.run_interval <= 0) {
        opts.runner.run_interval = 250;
    }

    if (typeof (opts.runner.activity_interval) !== 'number') {
        opts.runner.activity_interval = opts.runner.run_interval;
    }

    if (typeof (opts.runner.do_fork) === 'undefined') {
        opts.runner.do_fork = true;
    }

    var Backend = require(opts.backend.module);
    var identifier = opts.runner.identifier || null;
    var forks = opts.runner.forks;
    var run_interval = opts.runner.run_interval;
    var interval = null;
    var activity_interval = opts.runner.activity_interval;
    var ainterval = null;
    var shutting_down = false;
    var child_processes = {};
    var sandbox = opts.runner.sandbox || {};
    var slots = opts.runner.forks;
    var do_fork = opts.runner.do_fork;
    var rn_jobs = [];
    var job_runners = {};
    var dtrace = opts.dtrace;
    var log;
    if (opts.log) {
        log = opts.log({
            component: 'workflow-runner',
            runner_uuid: identifier
        });
    } else {
        if (!opts.logger) {
            opts.logger = {};
        }

        opts.logger.name = 'wf-runner';
        opts.logger.serializers = {
            err: bunyan.stdSerializers.err
        };

        opts.logger.streams = opts.logger.streams || [ {
            level: 'info',
            stream: process.stdout
        }];

        opts.logger.runner_uuid = identifier;

        log = bunyan.createLogger(opts.logger);
    }

    opts.backend.log = log;
    var backend = Backend(opts.backend.opts);


    function getIdentifier(callback) {
        var cfg_file = path.resolve(__dirname, '../workflow-indentifier');

        exists(cfg_file, function (exist) {
            if (exist) {
                fs.readFile(cfg_file, 'utf-8', function (err, data) {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, data);
                });
            } else {
                var id = uuid();
                fs.writeFile(cfg_file, id, 'utf-8', function (err) {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, id);
                });
            }
        });
    }


    function init(callback) {
        var series = [];
        // Job uuid, job name, job execution, job target,
        // job params, timeout & time elapsed
        dtrace.addProbe('wf-job-start',
                         'char *',
                         'char *',
                         'char *',
                         'char *',
                         'char *',
                         'int',
                         'char *');
        // Job uuid, job name, job execution, job target,
        // job params, timeout & time elapsed
        dtrace.addProbe('wf-job-done',
                         'char *',
                         'char *',
                         'char *',
                         'char *',
                         'char *',
                         'int',
                         'char *');
        // Task name, task body, start time (time we fire start probe)
        dtrace.addProbe('wf-task-start',
                        'char *',
                        'char *',
                        'int');
        // Task name, result, error, started_at/finished_at,
        // end time (time we fire done probe):
        dtrace.addProbe('wf-task-done',
                        'char *',
                        'char *',
                        'char *',
                        'int',
                        'int',
                        'int');
        // Enable dtrace provider first:
        try {
            dtrace.enable();
        } catch (e) {
            log.error({err: e}, 'Failed to enable DTrace Provider');
        }
        // Using async.series we can kind of write this sequentially and run
        // some methods only when needed:

        // 1) We need an unique identifier for this runner, also something
        //    human friendly to identify the runner from a bunch of them would
        //    be helpful.
        if (!identifier) {
            series.push(function runnerIdentifier(_, cb) {
                getIdentifier(function (err, uuid) {
                    if (err) {
                        return cb(err);
                    }
                    identifier = uuid;
                    // Not that we really care about the return value here,
                    // anyway:
                    return cb(null, uuid);
                });
            });
        }
        // The runner will register itself on the backend, with its unique id.
        series.push(function regRunner(_, cb) {
            backend.registerRunner(identifier, function (err) {
                if (err) {
                    return cb(err);
                }
                return cb(null, null);
            });
        });
        // 2) On init, the runner will check for any job flagged as running with
        //    the runner identifier. This means a previous failure so, first
        //    thing will be take care of such failure.
        series.push(function getRunnerJobs(_, cb) {
            backend.getRunnerJobs(identifier, function (err, jobs) {
                function markAsCanceled(uuid, next_cb) {
                    backend.cancelJob(uuid, function (err) {
                        if (err) {
                            return next_cb(err);
                        }
                        return next_cb(null);
                    });
                }
                if (err) {
                    return cb(err);
                } else {
                    return vasync.forEachParallel({
                        func: markAsCanceled,
                        inputs: jobs
                    }, function (err, results) {
                        if (err) {
                            return cb(err);
                        }
                        return cb(null, null);
                    });
                }
            });
        });

        backend.once('error', function (err) {
            return callback(err);
        });
        return backend.init(function () {
            vasync.pipeline({
                funcs: series
            }, function (err, results) {
                // Note we don't care at all about the results.
                if (err) {
                    return callback(err);
                }
                return callback();
            });
        });
    }

    // Wait for children to finish, do not began any other child process.
    // Call callback on done.
    function quit(callback) {
        shutting_down = true;
        clearTimeout(interval);
        clearTimeout(ainterval);
        if (rn_jobs.length > 0) {
            rn_jobs.forEach(function (j) {
                job_runners[j].cancel('queued', function (err) {
                    if (err) {
                        log.error({err: err}, 'Error trying to cancel job');
                    } else {
                        log.info('Job with UUID ' + j + ' canceled.');
                    }
                });
            });
        }
        if (slots < forks) {
            setTimeout(function () {
                quit(callback);
            }, run_interval);
        } else {
            callback();
        }
    }

    function runNow(job) {
        return (new Date().getTime() >= new Date(job.exec_after).getTime());
    }

    // Calculate the delay for the next retry.
    function nextRun(job) {
            var started = new Date(job.started).getTime();
            var elapsed = job.elapsed * 1000;
            var max = job.max_delay || Infinity;
            var initial = job.initial_delay || 0;
            var delay = initial * Math.pow(2, job.num_attempts);
            delay = Math.min(delay, max);

            return new Date(started + elapsed + delay).toISOString();
    }

    function childUp(job_uuid, child_pid) {
        child_processes[child_pid] = job_uuid;
    }

    function childDown(job_uuid, child_pid) {
        delete child_processes[child_pid];
    }

    function childCount() {
        return Object.keys(child_processes).length;
    }

    // Just in case we need to kill it without leaving child processes around:
    function kill(callback) {
        shutting_down = true;
        clearTimeout(interval);
        clearTimeout(ainterval);
        if (do_fork && childCount() > 0) {
            Object.keys(child_processes).forEach(function (p) {
                process.kill(p, 'SIGKILL');
            });
            child_processes = {};
        }
        if (callback) {
            callback();
        }
    }

    // Check for inactive runners.
    // "Inactive runner" - a runner with latest status report older than
    //  10 times the runners' run_interval.
    //  - callback - f(err, runners): `err` always means backend error.
    //    `runners` will be an array, even empty.
    function inactiveRunners(callback) {
        return backend.getRunners(function (err, runners) {
            if (err) {
                return callback(err);
            }
            var iRunners = [];
            Object.keys(runners).forEach(function (id) {
                var outdated = new Date().getTime() - (activity_interval * 10);
                if (id !== identifier &&
                  new Date(runners[id]).getTime() < outdated) {
                    iRunners.push(id);
                }
            });
            return callback(null, iRunners);
        });
    }


    // Check for "stale" jobs, i.e, associated with inactive runners.
    // - callback(err, jobs): `err` means backend error.
    //   `jobs` will be an array, even empty. Note this will be an
    //   array of jobs UUIDs, so they can be canceled.
    function staleJobs(callback) {
        return inactiveRunners(function (err, runners) {
            if (err) {
                return callback(err);
            }
            var sJobs = [];

            function getStaleJobs(runner, cb) {
                backend.getRunnerJobs(runner, function (err, jobs) {
                    if (err) {
                        return cb(err);
                    }
                    sJobs = sJobs.concat(jobs);
                    return cb(null, jobs);
                });
            }

            if (runners.length === 0) {
                return callback(null, []);
            } else {
                return vasync.forEachParallel({
                    inputs: runners,
                    func: getStaleJobs
                }, function (err, results) {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, sJobs);
                });
            }
        });
    }

    function getSlot() {
        if (slots === 0) {
            return false;
        } else {
            slots -= 1;
            return true;
        }
    }

    function releaseSlot() {
        if (slots >= forks) {
            log.error('Attempt to release more slots than available forks');
            return false;
        } else {
            slots += 1;
            return true;
        }
    }


    var runner = {
        init: init,
        quit: quit,
        // The next 5 are properties, possibly should encapsulate into methods:
        identifier: identifier,
        backend: backend,
        log: log,
        shutting_down: shutting_down,
        do_fork: do_fork,
        getIdentifier: getIdentifier,
        runNow: runNow,
        nextRun: nextRun,
        kill: kill,
        childUp: childUp,
        childDown: childDown,
        childCount: childCount,
        inactiveRunners: inactiveRunners,
        staleJobs: staleJobs,
        getSlot: getSlot,
        releaseSlot: releaseSlot
    };

    // This is the main runner method, where jobs execution takes place.
    // Every call to this method will result into a child_process being forked.
    function runJob(opts, callback) {
        assert.object(opts, 'opts');
        assert.object(opts.job, 'opts.job');
        assert.object(opts.trace, 'opts.trace');

        job_runners[opts.job.uuid] = WorkflowJobRunner({
            runner: runner,
            backend: backend,
            job: opts.job,
            log: opts.log,
            trace: opts.trace,
            sandbox: sandbox,
            dtrace: dtrace
        });
        job_runners[opts.job.uuid].run(callback);
    }

    // Put the runner to work
    function run() {
        shutting_down = false;
        function retryJob(oldJob, callback) {
            if (oldJob.num_attempts + 1 >= oldJob.max_attempts) {
                return callback(
                  'Max attempts reached. Last attempt: ' + oldJob.uuid);
            }

            var retryParams = {
                workflow: oldJob.workflow_uuid,
                params: oldJob.params,
                target: oldJob.target,
                num_attempts: oldJob.num_attempts + 1,
                exec_after: nextRun(oldJob)
            };

            var factory = Factory(backend);
            return factory.job(retryParams, function (err, newJob) {
                if (err) {
                    return callback(err);
                }
                // Update the old job with the next job's uuid and update the
                // new job with the old job's uuid.
                return backend.updateJobProperty(
                    oldJob.uuid,
                    'next_attempt',
                    newJob.uuid,
                    function (err) {
                        if (err) {
                            return callback(err);
                        }
                        return backend.updateJobProperty(
                            newJob.uuid,
                            'prev_attempt',
                            oldJob.uuid,
                            function (err) {
                                if (err) {
                                    return callback(err);
                                }
                                return callback();
                            });
                    });
            });
        }

        // Queue worker. Tries to run a job, including "hiding" it from other
        // runners:
        var worker = function (uuid, callback) {
            return backend.getJob(uuid, function (err, job) {
                if (err) {
                    return callback(err);
                }

                if (!job) {
                    return callback();
                }

                if (runNow(job)) {
                    var job_log = log.child({ job_uuid: job.uuid,
                        req_id: job.params['x-request-id'] });
                    var job_trace = trace_event.createBunyanTracer({
                        log: job_log,
                        fields: {
                            name: 'job.'
                                // Drop trailing '-$version'.
                                + job.name.slice(0, job.name.lastIndexOf('-')),
                            args: { job: job.uuid }
                        }
                    });
                    job_trace.begin(job_trace.fields.name + '.lock');

                    return backend.runJob(uuid, identifier,
                        function (err, job) {
                        job_trace.end(job_trace.fields.name + '.lock');
                        if (err) {
                            return callback(err);
                        }

                        if (!job) {
                            return callback();
                        }

                        var t = Date.now();
                        job_trace.begin();
                        dtrace.fire('wf-job-start', function jProbeStart() {
                            var ret = [
                                job.uuid,
                                job.name,
                                job.execution,
                                job.target,
                                JSON.stringify(job.params),
                                job.timeout,
                                String()
                            ];
                            return (ret);
                        });
                        var runJobOpts = {
                            job: job,
                            trace: job_trace,
                            log: job_log
                        };
                        return runJob(runJobOpts, function (err) {
                            dtrace.fire('wf-job-done', function jProbeDone() {
                                var ret = [
                                    job.uuid,
                                    job.name,
                                    job.execution,
                                    job.target,
                                    JSON.stringify(job.params),
                                    job.timeout,
                                    String()
                                ];
                                return (ret);
                            });
                            job_trace.end();
                            var logLevel = (job.execution === 'succeeded' ?
                                'info' : 'warn');
                            job_log[logLevel]({
                                job: {
                                    uuid: job.uuid,
                                    name: job.name,
                                    execution: job.execution
                                },
                                runtime: (Date.now() - t)
                            }, 'job completed');

                            delete job_runners[job.uuid];

                            if (err && err === 'retry') {
                                return retryJob(job, callback);
                            } else if (err) {
                                return callback(err);
                            }
                            return callback();
                        });
                    });
                } else {
                    return callback();
                }
            });
        };

        // We keep a queue with concurrency limit where we'll be pushing new
        // jobs
        var queue = vasync.queue(worker, forks - 1);

        function reportActivity() {
            backend.runnerActive(identifier, function (err) {
                if (err) {
                    log.error({err: err}, 'Error reporting runner activity');
                } else {
                    log.debug({runner: identifier}, 'Runner is active');
                }
                if (!shutting_down) {
                    ainterval = setTimeout(reportActivity, activity_interval);
                }
                return;
            });
        }

        function doPoll() {
            backend.isRunnerIdle(identifier, function (idle) {
                if (idle === false) {
                    vasync.parallel({
                        // Fetch stale jobs from runners which stopped
                        // reporting activity and cancel them:
                        funcs: [function cancelStaleJobs(cb) {
                            staleJobs(function (err, jobs) {
                                if (err) {
                                    log.error({err: err},
                                      'Error fetching stale jobs');
                                    // We will not stop even on error:
                                    return cb(null, null);
                                }
                                function cancelJobs(uuid, fe_cb) {
                                    backend.updateJobProperty(
                                      uuid, 'execution', 'canceled',
                                        function (err) {
                                            if (err) {
                                                return fe_cb(err);
                                            }
                                            return backend.getJob(uuid,
                                              function (err, job) {
                                                if (err) {
                                                    return fe_cb(err);
                                                }
                                                return backend.finishJob(
                                                  job, function (err, job) {
                                                    if (err) {
                                                        return fe_cb(err);
                                                    }
                                                    log.info(
                                                      'Stale Job ' +
                                                      job.uuid +
                                                      ' canceled');
                                                    return fe_cb(null);
                                                });
                                            });
                                      });
                                }
                                return vasync.forEachParallel({
                                    inputs: jobs,
                                    func: cancelJobs
                                }, function (err, results) {
                                    return cb(null, null);
                                });
                            });
                        },
                        // Fetch jobs to process.
                        function fetchJobsToProcess(cb) {
                            var fetch = slots - 1;
                            if (isNaN(fetch) || fetch <= 0) {
                                log.info('No available slots. ' +
                                    'Waiting next iteration');
                                return cb(null, null);
                            }
                            return backend.nextJobs(0, fetch,
                                function (err, jobs) {
                                // Error fetching jobs
                                if (err) {
                                    log.error({err: err},
                                      'Error fetching jobs');
                                    // We will not stop even on error:
                                    return cb(null, null);
                                }
                                // No queued jobs
                                if (!jobs) {
                                    return cb(null, null);
                                }
                                // Got jobs, let's see if we can run them:
                                jobs.forEach(function (job) {
                                    if (rn_jobs.indexOf(job) === -1) {
                                        rn_jobs.push(job);
                                        queue.push(job, function (err) {
                                            // Called once queue worker
                                            // finished processing the job
                                            if (err) {
                                                log.error({err: err},
                                                  'Error running job');
                                            }
                                            log.info('Job with uuid ' +
                                              job +
                                              ' ran successfully');
                                            if (rn_jobs.indexOf(job) !==
                                                -1) {
                                                rn_jobs.splice(
                                                    rn_jobs.indexOf(job),
                                                    1);
                                            }
                                        });
                                    }
                                });
                                return cb(null, null);
                            });
                        }]
                    }, function (err, results) {
                        if (!shutting_down) {
                            interval = setTimeout(doPoll, run_interval);
                        }
                        return;
                    });
                } else {
                    log.info('Runner idle.');
                    if (!shutting_down) {
                        interval = setTimeout(doPoll, run_interval);
                    }
                }
            });
        }

        reportActivity();
        doPoll();
    }


    runner.run = run;
    return runner;
};
