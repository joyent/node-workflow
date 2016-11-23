// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util');
var path = require('path');
var fs = require('fs');
var test = require('tap').test;
var uuid = require('uuid');
var WorkflowRunner = require('../lib/runner');
var Factory = require('../lib/index').Factory;
var exists = fs.exists || path.exists;
var createDTrace = require('../lib/index').CreateDTrace;

var backend, identifier, runner, factory;

var config = {};

var okTask = {
    name: 'OK Task',
    retry: 1,
    body: function (job, cb) {
        return cb(null);
    }
};
var failTask = {
    retry: 1,
    name: 'Fail Task',
    body: function (job, cb) {
        job.log.info('recording some info');
        return cb('Fail task error');
    }
};
var failTaskWithError = {
    retry: 1,
    name: 'Fail Task with error',
    body: function (job, cb) {
        job.log.info('recording some info');
        return cb(new Error('Fail task error'));
    }

};
var failTaskWithJobRetry = {
    retry: 1,
    name: 'Fail Task with job retry',
    body: function (job, cb) {
        return cb('retry');
    }
};
var failTaskWithJobWait = {
    retry: 1,
    name: 'Fail Task with job wait',
    body: function (job, cb) {
        return cb('wait');
    }
};
var taskWithModules = {
    name: 'OK Task with modules',
    retry: 1,
    body: function (job, cb) {
        if (typeof (uuid) !== 'function') {
            return cb('uuid module is not defined');
        }
        return cb(null);
    },
    modules: {
        uuid: 'uuid'
    }
};
var okWf, failWf, theJob, failWfWithError, failWfWithRetry;

var helper = require('./helper');

var DTRACE = createDTrace('workflow');

test('throws on missing opts', function (t) {
    t.throws(function () {
        return WorkflowRunner();
    }, new TypeError('opts (Object) required'));
    t.end();
});


test('throws on missing backend', function (t) {
    t.throws(function () {
        return WorkflowRunner(config);
    }, new TypeError('opts.backend (Object) required'));
    t.end();
});


test('throws on missing dtrace', function (t) {
    config = helper.config();
    t.throws(function () {
        return WorkflowRunner(config);
    }, new TypeError('opts.dtrace (Object) required'));
    t.end();
});


test('setup', function (t) {
    config.dtrace = DTRACE;
    identifier = config.runner.identifier;
    config.logger = {
        streams: [ {
            level: 'info',
            stream: process.stdout
        }, {
            level: 'trace',
            path: path.resolve(__dirname, './test.runner.log')
        }]
    };
    runner = WorkflowRunner(config);
    t.ok(runner);
    t.ok(runner.backend, 'backend ok');
    backend = runner.backend;
    runner.init(function (err) {
        t.ifError(err, 'runner init error');
        factory = Factory(backend);
        t.ok(factory);

        // okWf:
        factory.workflow({
            name: 'OK wf',
            chain: [okTask, failTaskWithJobWait, taskWithModules],
            timeout: 60
        }, function (err, wf) {
            t.ifError(err, 'ok wf error');
            t.ok(wf, 'OK wf OK');
            okWf = wf;
            // failWf:
            factory.workflow({
                name: 'Fail wf',
                chain: [failTask],
                timeout: 60
            }, function (err, wf) {
                t.ifError(err, 'Fail wf error');
                t.ok(wf, 'Fail wf OK');
                failWf = wf;
                factory.workflow({
                    name: 'Fail wf with error',
                    chain: [failTaskWithError],
                    timeout: 60
                }, function (err, wf) {
                    t.ifError(err, 'Fail wf with error');
                    t.ok(wf, 'Fail wf with error OK');
                    failWfWithError = wf;
                    factory.workflow({
                        name: 'Fail wf with retry',
                        chain: [failTaskWithJobRetry],
                        timeout: 60,
                        max_attempts: 3
                    }, function (err, wf) {
                        t.ifError(err, 'Fail wf with retry');
                        t.ok(wf, 'Fail wf with retry OK');
                        failWfWithRetry = wf;
                        backend.getRunners(function (err, runners) {
                            t.ifError(err, 'get runners error');
                            t.ok(runners[identifier], 'runner id ok');
                            t.ok(new Date(runners[identifier]),
                                'runner timestamp ok');
                            t.end();
                        });
                    });
                });
            });
        });
    });
});


test('runner identifier', function (t) {
    var cfg = {
        backend: helper.config().backend,
        dtrace: DTRACE
    }, aRunner = WorkflowRunner(cfg),
    identifier;
    // run getIdentifier twice, one to create the file,
    // another to just read it:
    aRunner.init(function (err) {
        t.ifError(err, 'runner init error');
        aRunner.getIdentifier(function (err, id) {
            t.ifError(err, 'get identifier error');
            t.ok(id, 'get identifier id');
            identifier = id;
            aRunner.getIdentifier(function (err, id) {
                t.ifError(err, 'get identifier error');
                t.equal(id, identifier, 'correct id');
                aRunner.backend.quit(function () {
                    t.end();
                });
            });
        });
    });
});


test('runner run job now', function (t) {
    var d = new Date();
    t.ok(runner.runNow({exec_after: d.toISOString()}));
    // Set to the future, so it shouldn't run:
    d.setTime(d.getTime() + 10000);
    t.ok(!runner.runNow({exec_after: d.toISOString()}));
    t.end();
});


test('runner next run', function (t) {
    var d = Date.now();
    var job = {
        started: d,
        elapsed: 1.23,
        max_delay: 7000,
        initial_delay: 1000,
        num_attempts: 0
    };
    t.equal(new Date(runner.nextRun(job)).getTime(), d + 1230 + 1000);
    job.num_attempts++;
    t.equal(new Date(runner.nextRun(job)).getTime(), d + 1230 + 2000);
    job.num_attempts++;
    t.equal(new Date(runner.nextRun(job)).getTime(), d + 1230 + 4000);
    job.num_attempts++;
    t.equal(new Date(runner.nextRun(job)).getTime(), d + 1230 + 7000);
    job.num_attempts++;
    t.equal(new Date(runner.nextRun(job)).getTime(), d + 1230 + 7000);
    t.end();
});


test('idle runner', function (t) {
    runner.run();
    backend.idleRunner(runner.identifier, function (err) {
        t.ifError(err, 'idle runner error');
        factory.job({
            workflow: okWf.uuid,
            exec_after: '2012-01-03T12:54:05.788Z'
        }, function (err, job) {
            t.ifError(err, 'job error');
            t.ok(job, 'run job ok');
            theJob = job;
            // The job is queued. The runner is idle. Job should remain queued:
            backend.getJob(theJob.uuid, function (err, j) {
                t.ifError(err, 'run job get job error');
                t.equal(j.execution, 'queued', 'job execution');
                runner.quit(function () {
                    t.end();
                });
            });
        });
    });
});


test('run job', function (t) {
    // Let's remove the idleness of the runner so it will pick the job
    backend.wakeUpRunner(runner.identifier, function (err) {
        t.ifError(err, 'wake up runner error');
        runner.run();
        setTimeout(function () {
            runner.quit(function () {
                backend.getJob(theJob.uuid, function (err, job) {
                    t.ifError(err, 'run job get job error');
                    t.equal(job.execution, 'waiting', 'job execution');
                    t.equal(job.chain_results[0].result, 'OK');
                    t.equal(job.chain_results[1].result, 'OK');
                    theJob = job;
                    t.end();
                });
            });
        }, 1000);
    });
});


test('re-run waiting job', function (t) {
    backend.resumeJob(theJob, function (err, job) {
        t.ifError(err, 'resume job error');
        theJob = job;
        runner.run();
        setTimeout(function () {
            runner.quit(function () {
                backend.getJob(theJob.uuid, function (err, job) {
                    t.ifError(err, 'run job get job error');
                    t.equal(job.execution, 'succeeded', 'job execution');
                    t.equal(job.chain_results[0].result, 'OK');
                    t.equal(job.chain_results[1].result, 'OK');
                    t.end();
                });
            });
        }, 1000);
    });
});


test('run job which fails', function (t) {
    var aJob;
    factory.job({
        workflow: failWf.uuid,
        exec_after: '2012-01-03T12:54:05.788Z'
    }, function (err, job) {
        t.ifError(err, 'job error');
        t.ok(job, 'job ok');
        aJob = job;
        runner.run();
        setTimeout(function () {
            runner.quit(function () {
                backend.getJob(aJob.uuid, function (err, job) {
                    t.ifError(err, 'get job error');
                    t.equal(job.execution, 'failed', 'job execution');
                    t.equal(job.chain_results[0].error, 'Fail task error');
                    t.end();
                });
            });
        }, 300);
    });
});


test('run job which fails with error instance', function (t) {
    var aJob;
    factory.job({
        workflow: failWfWithError.uuid,
        exec_after: '2012-01-03T12:54:05.788Z'
    }, function (err, job) {
        t.ifError(err, 'job error');
        t.ok(job, 'job ok');
        aJob = job;
        runner.run();
        setTimeout(function () {
            runner.quit(function () {
                backend.getJob(aJob.uuid, function (err, job) {
                    t.ifError(err, 'get job error');
                    t.equal(job.execution, 'failed', 'job execution');
                    t.ok(job.chain_results[0].error.name);
                    t.ok(job.chain_results[0].error.message);
                    t.equal(job.chain_results[0].error.message,
                        'Fail task error');
                    t.end();
                });
            });
        }, 300);
    });
});


test('a job that is retried', function (t) {
    var aJob;
    factory.job({
        workflow: failWfWithRetry.uuid,
        exec_after: '2012-01-03T12:54:05.788Z'
    }, function (err, job) {
        t.ifError(err, 'job error');
        t.ok(job, 'job ok');
        aJob = job;
        runner.run();
        setTimeout(function () {
            runner.quit(function () {
                backend.getJob(aJob.uuid, function (err, job) {
                    t.ifError(err, 'get job error');
                    t.equal(job.execution, 'retried', 'job execution');
                    t.equal(job.chain_results[0].error, 'retry', 'error');
                    var prevJob = job;
                    backend.getJob(job.next_attempt, function (err, job) {
                        t.ifError(err, 'get job error');
                        t.equal(job.execution, 'retried', 'job execution');
                        t.equal(job.chain_results[0].error, 'retry', 'error');
                        t.equal(prevJob.uuid, job.prev_attempt);
                        var midJob = job;
                        backend.getJob(job.next_attempt, function (err, job) {
                            t.ifError(err, 'get job error');
                            t.equal(job.execution, 'retried', 'job execution');
                            t.equal(job.chain_results[0].error, 'retry');
                            t.equal(midJob.uuid, job.prev_attempt);
                            t.notOk(job.next_attempt);
                            t.end();
                        });
                    });
                });
            });
        }, 2000);
    });
});


test('inactive runners', function (t) {
    // Add another runner, which we'll set as inactive
    var theUUID = uuid(),
    cfg = {
        backend: helper.config().backend,
        runner: {
            identifier: theUUID,
            forks: 2,
            run_interval: 250
        },
        dtrace: DTRACE
    },
    anotherRunner = WorkflowRunner(cfg);
    t.ok(anotherRunner, 'another runner ok');
    // Init the new runner, then update it to make inactive
    anotherRunner.init(function (err) {
        t.ifError(err, 'another runner init error');
        // Now we quit the new runner, and outdate it:
        anotherRunner.quit(function () {
            runner.inactiveRunners(function (err, runners) {
                t.ifError(err, 'inactive runners error');
                t.ok(util.isArray(runners), 'runners is array');
                t.equal(runners.length, 0, 'runners length');
                backend.runnerActive(
                    anotherRunner.identifier,
                    '2012-01-03T12:54:05.788Z',
                    function (err) {
                        t.ifError(err, 'set runner timestamp error');
                        runner.inactiveRunners(function (err, runners) {
                            t.ifError(err, 'inactive runners error');
                            t.ok(util.isArray(runners), 'runners is array');
                            t.equal(runners.length, 1, 'runners length');
                            t.equal(runners[0], theUUID, 'runner uuid error');
                            anotherRunner.backend.quit(function () {
                                t.end();
                            });
                        });
                  });
            });
        });
    });
});


test('stale jobs', function (t) {
    // Add another runner, which we'll set as inactive
    var theUUID = uuid(),
    cfg = {
        backend: helper.config().backend,
        runner: {
            identifier: theUUID,
            forks: 2,
            run_interval: 250
        },
        dtrace: DTRACE
    },
    anotherRunner = WorkflowRunner(cfg),
    aJob;
    t.ok(anotherRunner, 'another runner ok');

    factory.job({
        workflow: okWf.uuid,
        exec_after: '2012-01-03T12:54:05.788Z'
    }, function (err, job) {
        t.ifError(err, 'job error');
        t.ok(job, 'run job ok');
        aJob = job;
        // Init the new runner, then update it to make inactive
        anotherRunner.init(function (err) {
            t.ifError(err, 'another runner init error');
            backend.runJob(aJob.uuid, anotherRunner.identifier,
              function (err, job) {
                t.ifError(err, 'backend run job error');
                // The runner is not inactive; therefore, no stale jobs
                runner.staleJobs(function (err, jobs) {
                    t.ifError(err, 'stale jobs error');
                    t.equivalent(jobs, [], 'stale jobs empty');
                    // Now we quit the new runner, and outdate it:
                    anotherRunner.quit(function () {
                        // The runner will be inactive so, any job flagged
                        // as owned by this runner will be stale
                        backend.runnerActive(
                          anotherRunner.identifier,
                          '2012-01-03T12:54:05.788Z',
                          function (err) {
                            t.ifError(err, 'set runner timestamp error');
                            // Our job should be here now:
                            runner.staleJobs(function (err, jobs) {
                                t.ifError(err, 'stale jobs 2 error');
                                t.equivalent([aJob.uuid], jobs);
                                // Let's set the job canceled and finish it:
                                backend.updateJobProperty(
                                  aJob.uuid,
                                  'execution',
                                  'canceled',
                                  function (err) {
                                    t.ifError(err, 'update job prop err');
                                    aJob.execution = 'canceled';
                                    backend.finishJob(aJob,
                                      function (err, job) {
                                        t.ifError(err, 'finish job err');
                                        t.ok(job, 'finish job ok');
                                        runner.staleJobs(function (err, jobs) {
                                            t.ifError(err,
                                              'stale jobs 3 error');
                                            t.equivalent(jobs, []);
                                            anotherRunner.backend.quit(
                                              function () {
                                                t.end();
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});


test('teardown', function (t) {
    var cfg_file = path.resolve(__dirname, '../workflow-indentifier');
    runner.backend.quit(function () {
        exists(cfg_file, function (exist) {
            if (exist) {
                fs.unlink(cfg_file, function (err) {
                    t.ifError(err);
                    t.end();
                });
            } else {
                t.end();
            }
        });
    });
});
