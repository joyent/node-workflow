// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
// Copyright (c) 2017, Joyent, Inc.

var util = require('util');
var makeEmitter = require('./make-emitter');
var Logger = require('bunyan');
var e = require('./errors');
var clone = require('clone');
var sprintf = util.format;

// Returns true when "obj" (Object) has all the properties "kv" (Object) has,
// and with exactly the same values, otherwise, false
function hasPropsAndVals(obj, kv) {
    if (typeof (obj) !== 'object' || typeof (kv) !== 'object') {
        return (false);
    }

    if (Object.keys(kv).length === 0) {
        return (true);
    }

    return (Object.keys(kv).every(function (k) {
        return (obj[k] && obj[k] === kv[k]);
    }));
}

var Backend = module.exports = function (config) {

    var log;

    if (config.log) {
        log = config.log.child({component: 'wf-in-memory-backend'});
    } else {
        if (!config.logger) {
            config.logger = {};
        }

        config.logger.name = 'wf-in-memory-backend';
        config.logger.serializers = {
            err: Logger.stdSerializers.err
        };

        config.logger.streams = config.logger.streams || [ {
            level: 'info',
            stream: process.stdout
        }];

        log = new Logger(config.logger);
    }

    var workflows = null;
    var jobs = null;
    var runners = null;
    var queued_jobs = null;
    var waiting_jobs = null;
    var locked_targets = {};

    function _lockedTargets() {
        var targets = Object.keys(locked_targets).map(function (t) {
            return locked_targets[t];
        });
        return targets;
    }

    function _wfNames() {
        var wf_names = Object.keys(workflows).map(function (uuid) {
            return workflows[uuid].name;
        });
        return wf_names;
    }

    function _jobTargets() {
        var wf_job_targets = Object.keys(jobs).map(function (uuid) {
            return jobs[uuid].target;
        });
        return wf_job_targets;
    }

    function getJob(uuid, meta, callback) {
        if (typeof (meta) === 'function') {
            callback = meta;
            meta = {};
        }

        if (jobs[uuid]) {
            return callback(null, clone(jobs[uuid]));
        } else {
            return callback(new e.BackendResourceNotFoundError(sprintf(
              'Job with uuid \'%s\' does not exist', uuid)));
        }
    }

    // Register a runner on the backend and report it's active:
    // - runner_id - String, unique identifier for runner.
    // - active_at - ISO String timestamp. Optional. If none is given,
    //   current time
    // - callback - f(err)
    function registerRunner(runner_id, active_at, callback) {
        if (typeof (active_at) === 'function') {
            callback = active_at;
            active_at = new Date();
        }
        if (typeof (active_at) === 'string') {
            active_at = new Date(active_at);
        }
        runners[runner_id] = {
            runner_id: runner_id,
            active_at: active_at,
            idle: false
        };
        return callback(null);
    }

    var backend = {
        log: log,
        init: function init(callback) {
            workflows = {};
            jobs = {};
            runners = {};
            queued_jobs = [];
            waiting_jobs = [];
            return callback();
        },

        quit: function quit(callback) {
            return callback();
        },
        // workflow - Workflow object
        // meta - Any additional information to pass to the backend which is not
        //        workflow properties
        // callback - f(err, workflow)
        createWorkflow: function createWorkflow(workflow, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }
            if (_wfNames().indexOf(workflow.name) !== -1) {
                return callback(new e.BackendInvalidArgumentError(
                  'Workflow.name must be unique. A workflow with name "' +
                  workflow.name + '" already exists'));
            } else {
                workflows[workflow.uuid] = clone(workflow);
                return callback(null, workflow);
            }
        },

        // uuid - Workflow.uuid
        // meta - Any additional information to pass to the backend which is not
        //        workflow properties
        // callback - f(err, workflow)
        getWorkflow: function getWorkflow(uuid, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (workflows[uuid]) {
                return callback(null, clone(workflows[uuid]));
            } else {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Workflow with uuid \'%s\' does not exist', uuid)));
            }
        },

        // workflow - the workflow object
        // meta - Any additional information to pass to the backend which is not
        //        workflow properties
        // callback - f(err, boolean)
        deleteWorkflow: function deleteWorkflow(workflow, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (workflows[workflow.uuid]) {
                return callback(null, (delete workflows[workflow.uuid]));
            } else {
                return callback(null, false);
            }
        },

        // workflow - update workflow object.
        // meta - Any additional information to pass to the backend which is not
        //        workflow properties
        // callback - f(err, workflow)
        updateWorkflow: function updateWorkflow(workflow, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (workflows[workflow.uuid]) {
                if (_wfNames().indexOf(workflow.name) !== -1 &&
                    workflows[workflow.uuid].name !== workflow.name) {
                    return callback(new e.BackendInvalidArgumentError(
                      'Workflow.name must be unique. A workflow with name "' +
                      workflow.name + '" already exists'));
                } else {
                    workflows[workflow.uuid] = clone(workflow);
                    return callback(null, workflow);
                }
            } else {
                return callback(new e.BackendResourceNotFoundError(
                  'Workflow does not exist. Cannot Update.'));
            }
        },

        // job - Job object
        // meta - Any additional information to pass to the backend which is not
        //        job properties
        // callback - f(err, job)
        createJob: function createJob(job, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            job.created_at = job.created_at || new Date().toISOString();
            jobs[job.uuid] = clone(job);
            queued_jobs.push(job.uuid);
            if (typeof (job.locks) !== 'undefined') {
                locked_targets[job.uuid] = job.locks;
            }
            return callback(null, job);
        },

        // uuid - Job.uuid
        // meta - Any additional information to pass to the backend which is not
        //        job properties
        // callback - f(err, job)
        getJob: getJob,

        // Get a single job property
        // uuid - Job uuid.
        // prop - (String) property name
        // cb - callback f(err, value)
        getJobProperty: function (uuid, prop, cb) {
            if (jobs[uuid]) {
                return cb(null, jobs[uuid][prop]);
            } else {
                return cb(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', uuid)));
            }
        },

        // job - the job object
        // callback - f(err) called with error in case there is a duplicated
        // job with the same target and same params
        validateJobTarget: function validateJobTarget(job, callback) {
            // If no target is given, we don't care:
            if (!job.target) {
                return callback(null);
            }

            var locked = _lockedTargets().some(function (r) {
                var re = new RegExp(r);
                return (re.test(job.target));
            });

            if (locked) {
                return callback(new e.BackendInvalidArgumentError(
                    'Job target is currently locked by another job'));
            }

            if (_jobTargets().indexOf(job.target) === -1) {
                return callback(null);
            }

            var filtered = Object.keys(jobs).filter(function (uuid) {
                return (
                  uuid !== job.uuid &&
                  jobs[uuid].target === job.target &&
                  Object.keys(job.params).every(function (p) {
                    return (jobs[uuid].params[p] &&
                      jobs[uuid].params[p] === job.params[p]);
                }) &&
                  (jobs[uuid].execution === 'queued' ||
                   jobs[uuid].execution === 'running'));
            });

            if (filtered.length !== 0) {
                return callback(new e.BackendInvalidArgumentError(
                  'Another job with the same target' +
                  ' and params is already queued'));
            } else {
                return callback(null);
            }
        },

        // Get the next queued job.
        // index - Integer, optional. When given, it'll get the job at index
        //         position (when not given, it'll return the job at position
        //         zero).
        // callback - f(err, job)
        nextJob: function nextJob(index, callback) {
            if (typeof (index) === 'function') {
                callback = index;
                index = 0;
            }

            if (queued_jobs.length === 0) {
                return callback(null, null);
            }

            var slice = queued_jobs.slice(index, index + 1);

            if (slice.length === 0) {
                return callback(null, null);
            } else {
                return getJob(slice[0], callback);
            }
        },

        // Lock a job, mark it as running by the given runner, update job
        // status.
        // uuid - the job uuid (String)
        // runner_id - the runner identifier (String)
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        runJob: function runJob(uuid, runner_id, callback) {
            var idx = queued_jobs.indexOf(uuid);
            if (idx === -1) {
                return callback(new e.BackendPreconditionFailedError(
                  'Only queued jobs can be run'));
            } else {
                queued_jobs.splice(idx, 1);
                jobs[uuid].runner_id = runner_id;
                jobs[uuid].execution = 'running';
                return callback(null, clone(jobs[uuid]));
            }
        },

        // Unlock the job, mark it as finished, update the status, add the
        // results for every job's task.
        // job - the job object. It'll be saved to the backend with the provided
        //       properties.
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        finishJob: function finishJob(job, callback) {
            if (!jobs[job.uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', job.uuid)));
            } else if (jobs[job.uuid].execution !== 'running' &&
                jobs[job.uuid].execution !== 'canceled') {
                return callback(new e.BackendPreconditionFailedError(
                  'Only running jobs can be finished'));
            } else {
                if (job.execution === 'running') {
                    job.execution = 'succeeded';
                }
                var info = jobs[job.uuid].info;
                job.runner_id = null;
                jobs[job.uuid] = clone(job);
                if (info) {
                    jobs[job.uuid].info = info;
                }
                if (typeof (job.locks) !== 'undefined') {
                    delete locked_targets[job.uuid];
                }
                return callback(null, job);
            }
        },

        // Update the job while it is running with information regarding
        // progress
        // job - the job object. It'll be saved to the backend with the
        //       provided properties.
        // meta - Any additional information to pass to the backend which is
        //        not job properties
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        updateJob: function updateJob(job, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (!jobs[job.uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', job.uuid)));
            } else {
                jobs[job.uuid] = clone(job);
                return callback(null, job);
            }
        },

        // Unlock the job, mark it as canceled, and remove the runner_id
        // uuid - string, the job uuid.
        // cb - f(err, job) callback will be called with error if something
        //           fails, otherwise it'll return the updated job using getJob.
        cancelJob: function cancelJob(uuid, cb) {
            if (typeof (uuid) === 'undefined') {
                return cb(new e.BackendInternalError(
                  'cancelJob uuid(String) required'));
            }

            jobs[uuid].execution = 'canceled';
            delete jobs[uuid].runner_id;
            if (typeof (jobs[uuid].locks) !== 'undefined') {
                delete locked_targets[uuid];
            }
            return cb(null, jobs[uuid]);
        },

        // Update only the given Job property. Intendeed to prevent conflicts
        // with two sources updating the same job at the same time, but
        // different properties:
        // - uuid - the job's uuid
        // - prop - the name of the property to update
        // - val - value to assign to such property
        // - meta - Any additional information to pass to the backend which is
        //          not job properties
        // - callback - f(err) called with error if something fails, otherwise
        //              with null.
        updateJobProperty: function updateJobProperty(
            uuid,
            prop,
            val,
            meta,
            callback)
        {

            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (!jobs[uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', uuid)));
            } else {
                jobs[uuid][prop] = val;
                return callback(null);
            }
        },

        // Queue a job which has been running; i.e, due to whatever the reason,
        // re-queue the job. It'll unlock the job, update the status, add the
        // results for every finished task so far ...
        // job - the job Object. It'll be saved to the backend with the provided
        //       properties to ensure job status persistence.
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        queueJob: function queueJob(job, callback) {
            if (!jobs[job.uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', job.uuid)));
            } else if (jobs[job.uuid].execution !== 'running') {
                return callback(new e.BackendPreconditionFailedError(
                  'Only running jobs can be queued again'));
            } else {
                job.runner_id = null;
                job.execution = 'queued';
                jobs[job.uuid] = clone(job);
                queued_jobs.push(job.uuid);
                return callback(null, job);
            }
        },

        // Pause a job which has been running; i.e, tell the job to wait for
        // something external to happen. It'll unlock the job, update the
        // status, add the results for every finished task so far ...
        // job - the job Object. It'll be saved to the backend with the provided
        //       properties to ensure job status persistence.
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        pauseJob: function pauseJob(job, callback) {
            if (!jobs[job.uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', job.uuid)));
            } else if (jobs[job.uuid].execution !== 'running') {
                return callback(new e.BackendPreconditionFailedError(
                  'Only running jobs can be paused'));
            } else {
                job.runner_id = null;
                job.execution = 'waiting';
                jobs[job.uuid] = clone(job);
                waiting_jobs.push(job.uuid);
                return callback(null, job);
            }
        },

        // Tell a waiting job that whatever it has been waiting for has
        // happened and it can run again.
        // job - the job Object. It'll be saved to the backend with the provided
        //       properties to ensure job status persistence.
        // callback - f(err, job) callback will be called with error if
        //            something fails, otherwise it'll return the updated job
        //            using getJob.
        resumeJob: function resumeJob(job, callback) {
            if (!jobs[job.uuid]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Job with uuid \'%s\' does not exist', job.uuid)));
            } else if (jobs[job.uuid].execution !== 'waiting') {
                return callback(new e.BackendPreconditionFailedError(
                  'Only waiting jobs can be resumed'));
            } else {
                job.runner_id = null;
                job.execution = 'queued';
                jobs[job.uuid] = clone(job);
                waiting_jobs = waiting_jobs.filter(function (j) {
                    return (j !== job.uuid);
                });
                queued_jobs.push(job.uuid);
                return callback(null, job);
            }
        },

        // Get the given number of queued jobs uuids.
        // - start - Integer - Position of the first job to retrieve
        // - stop - Integer - Position of the last job to retrieve, _included_
        // - callback - f(err, jobs)
        nextJobs: function nextJobs(start, stop, callback) {
            if (queued_jobs.length === 0) {
                return callback(null, null);
            }

            var slice = queued_jobs.slice(start, stop + 1);

            if (slice.length === 0) {
                return callback(null, null);
            } else {
                return callback(null, slice);
            }
        },

        // Register a runner on the backend and report it's active:
        // - runner_id - String, unique identifier for runner.
        // - active_at - ISO String timestamp. Optional. If none is given,
        //   current time
        // - callback - f(err)
        registerRunner: registerRunner,

        // Report a runner remains active:
        // - runner_id - String, unique identifier for runner. Required.
        // - active_at - ISO String timestamp. Optional. If none is given,
        //   current time
        // - callback - f(err)
        runnerActive: function runnerActive(runner_id, active_at, callback) {
            return registerRunner(runner_id, active_at, callback);
        },

        // Get the given runner id details
        // - runner_id - String, unique identifier for runner. Required.
        // - callback - f(err, runner)
        getRunner: function getRunner(runner_id, callback) {
            if (!runners[runner_id]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Runner with uuid \'%s\' does not exist', runner_id)));
            } else {
                return callback(null, runners[runner_id].active_at);
            }
        },

        // Get all the registered runners:
        // - callback - f(err, runners)
        getRunners: function getRunners(callback) {
            var theRunners = {};

            Object.keys(runners).forEach(function (uuid) {
                theRunners[uuid] = runners[uuid].active_at;
            });

            return callback(null, theRunners);
        },

        // Set a runner as idle:
        // - runner_id - String, unique identifier for runner
        // - callback - f(err)
        idleRunner: function idleRunner(runner_id, callback) {
            if (!runners[runner_id]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Runner with uuid \'%s\' does not exist', runner_id)));
            } else {
                runners[runner_id].idle = true;
                return callback(null);
            }
        },

        // Check if the given runner is idle
        // - runner_id - String, unique identifier for runner
        // - callback - f(boolean)
        isRunnerIdle: function isRunnerIdle(runner_id, callback) {
            if (!runners[runner_id] || (runners[runner_id].idle === true)) {
                return callback(true);
            } else {
                return callback(false);
            }
        },

        // Remove idleness of the given runner
        // - runner_id - String, unique identifier for runner
        // - callback - f(err)
        wakeUpRunner: function wakeUpRunner(runner_id, callback) {
            if (!runners[runner_id]) {
                return callback(new e.BackendResourceNotFoundError(sprintf(
                  'Runner with uuid \'%s\' does not exist', runner_id)));
            } else {
                runners[runner_id].idle = false;
                return callback(null);
            }
        },

        // Get all jobs associated with the given runner_id
        // - runner_id - String, unique identifier for runner
        // - callback - f(err, jobs). `jobs` is an array of job's UUIDs.
        //   Note `jobs` will be an array, even when empty.
        getRunnerJobs: function getRunnerJobs(runner_id, callback) {
            var wf_runner_jobs = Object.keys(jobs).filter(function (uuid) {
                    return jobs[uuid].runner_id === runner_id;
                });

            return callback(null, wf_runner_jobs);
        },

        // Get all the workflows:
        // - params - JSON Object (Optional). Can include the value of the
        //  workflow's "name", and any other key/value pair to search for
        //   into workflow's definition.
        // - callback - f(err, workflows)
        getWorkflows: function getWorkflows(params, callback) {

            if (typeof (params) === 'function') {
                callback = params;
                params = {};
            }

            var wfs = [];
            var rWorkflows = Object.keys(workflows).map(function (uuid) {
                return clone(workflows[uuid]);
            });

            rWorkflows.forEach(function (wf) {
                if (hasPropsAndVals(wf, params)) {
                    wfs.push(wf);
                }
            });
            return callback(null, wfs);
        },

        // Get all the jobs:
        // - params - JSON Object. Can include the value of the job's
        //   "execution" status, and any other key/value pair to search for
        //   into job'sparams.
        //   - execution - String, the execution status for the jobs to return.
        //                 Return all jobs if no execution status is given.
        // - callback - f(err, jobs)
        getJobs: function getJobs(params, callback) {
            var executions = [
                'queued',
                'failed',
                'succeeded',
                'canceled',
                'running',
                'retried',
                'waiting'
            ];
            var execution;
            var offset;
            var limit;
            var rJobs = [];
            var theJobs = [];

            if (typeof (params) === 'object') {
                execution = params.execution;
                delete params.execution;
                offset = params.offset;
                delete params.offset;
                limit = params.limit;
                delete params.limit;
            }

            if (typeof (params) === 'function') {
                callback = params;
                params = {};
            }


            if ((typeof (execution) !== 'undefined') &&
                    (executions.indexOf(execution) === -1)) {
                return callback(new e.BackendInvalidArgumentError(
                  'excution is required and must be one of "' +
                  executions.join('", "') + '"'));
            }

            if (typeof (execution) !== 'undefined') {
                rJobs = Object.keys(jobs).filter(function (uuid) {
                    return (jobs[uuid].execution === execution);
                }).map(function (uuid) {
                    return clone(jobs[uuid]);
                });
            } else {
                rJobs = Object.keys(jobs).map(function (uuid) {
                    return clone(jobs[uuid]);
                });
            }

            rJobs.forEach(function (job) {
                if (hasPropsAndVals(job.params, params)) {
                    theJobs.push(job);
                }
            });

            if (typeof (offset) !== 'undefined' &&
                    typeof (limit) !== 'undefined') {
                return callback(null, theJobs.slice(offset, limit));
            } else {
                return callback(null, theJobs);
            }
        },


        countJobs: function countJobs(callback) {
            var executions = [
                'queued',
                'failed',
                'succeeded',
                'canceled',
                'running',
                'retried',
                'waiting'
            ];

            var rJobs = [];
            var stats = {
                all_time: {},
                past_24h: {},
                past_hour: {},
                current: {}
            };

            executions.forEach(function (e) {
                stats.all_time[e] = 0;
                stats.past_24h[e] = 0;
                stats.past_hour[e] = 0;
                stats.current[e] = 0;
            });

            rJobs = Object.keys(jobs).map(function (uuid) {
                return clone(jobs[uuid]);
            });

            var yesterday = (function (d) {
                d.setDate(d.getDate() - 1);
                return d;
            })(new Date()).getTime();

            var _1hr = (function (d) {
                d.setHours(d.getHours() - 1);
                return d;
            })(new Date()).getTime();

            var _2hr = (function (d) {
                d.setHours(d.getHours() - 2);
                return d;
            })(new Date()).getTime();

            rJobs = rJobs.map(function (job) {
                return ({
                    execution: job.execution,
                    created_at: new Date(job.created_at).getTime()
                });
            });

            rJobs.forEach(function (j) {
                if (j.created_at < yesterday) {
                    stats.all_time[j.execution] += 1;
                } else if (j.created_at > yesterday && j.created_at < _2hr) {
                    stats.past_24h[j.execution] += 1;
                } else if (j.created_at > _2hr && j.created_at < _1hr) {
                    stats.past_hour[j.execution] += 1;
                } else {
                    stats.current[j.execution] += 1;
                }
            });
            return callback(null, stats);
        },


        // Add progress information to an existing job:
        // - uuid - String, the Job's UUID.
        // - info - Object, {'key' => 'Value'}
        // - meta - Any additional information to pass to the backend which is
        //        not job info
        // - callback - f(err)
        addInfo: function addInfo(uuid, info, meta, callback) {

            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (!jobs[uuid]) {
                return callback(new e.BackendResourceNotFoundError(
                  'Job does not exist. Cannot Update.'));
            } else {
                if (!util.isArray(jobs[uuid].info)) {
                    jobs[uuid].info = [];
                }
                jobs[uuid].info.push(info);
                return callback(null);
            }
        },

        // Get progress information from an existing job:
        // - uuid - String, the Job's UUID.
        // - callback - f(err, info)
        getInfo: function getInfo(uuid, meta, callback) {
            if (typeof (meta) === 'function') {
                callback = meta;
                meta = {};
            }

            if (!jobs[uuid]) {
                return callback(new e.BackendResourceNotFoundError(
                  'Job does not exist. Cannot get info.'));
            } else {
                if (!util.isArray(jobs[uuid].info)) {
                    jobs[uuid].info = [];
                }
                return callback(null, clone(jobs[uuid].info));
            }
        }

    };

    makeEmitter(backend);
    return backend;
};
