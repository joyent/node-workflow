// Copyright 2014 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var uuid = require('uuid');
var util = require('util');
var crypto = require('crypto');

var clone = require('clone');

var WorkflowFactory = module.exports = function (backend) {
    // Create a workflow and store it on the backend
    //
    // - workflow - the workflow object properties:
    //   - name: string workflow name, uniqueness enforced.
    //   - timeout: integer, acceptable time, in seconds, to run the wf.
    //     (60 minutes if nothing given). Also, the Boolean `false` can be used
    //     to explicitly create a workflow without a timeout.
    //   - chain: An array of Tasks to run.
    //   - onerror: An array of Tasks to run in case `chain` fails.
    //   - oncancel: An array of Tasks to run in case job is canceled.
    //   - max_attempts: integer, maximum number of attempts allowed for retries
    //     (10 if nothing given).
    //   - initial_delay: integer, initial delay in milliseconds before a retry
    //     is executed. (optional)
    //   - max_delay: integer, maximum delay in milliseconds between retries
    //     (optional)
    // - opts - Object, any additional information to be passed to the backend
    //          when creating a workflow object which are not workflow
    //          properties, like HTTP request ID or other meta information.
    // - callback - function(err, workflow)
    //
    // Every Task can have the following members:
    //   - name - string task name, optional.
    //   - body - function(job, cb) the task main function. Required.
    //   - fallback: function(err, job, cb) a function to run in case `body`
    //     fails. Optional.
    //   - retry: Integer, number of attempts to run the task before try
    //     `fallback`. Optional. By default, just one retry.
    //   - timeout: Integer, acceptable time, in seconds, a task execution
    //     should take, before fail it with timeout error. Optional.
    //
    function workflow(w, opts, callback) {
        var wf = w || {};

        if (typeof (opts) === 'function') {
            callback = opts;
            opts = {};
        }

        function validateTask(task, cb) {
            var p;

            if (!task.body) {
                return cb('Task "body" is required');
            }

            if (typeof (task.body) !== 'function') {
                return cb('Task "body" must be a function');
            }

            if (!task.uuid) {
                task.uuid = uuid();
            }

            // Ensure that if task.fallback is given, it's a function
            if (task.fallback && typeof (task.fallback) !== 'function') {
                return cb('Task "fallback" must be a function');
            }

            // If task is overriding modules to load, make sure it's a
            // proper object with keys:
            if (task.modules &&
                    (typeof (task.modules) !== 'object' ||
                     !Array.isArray(Object.keys(task.modules)))) {
                return cb('Task "modules" must be an object');
            }
            for (p in task) {
                if (typeof (task[p]) === 'function') {
                    task[p] = task[p].toString();
                } else if (typeof (task[p]) === 'object') {
                    task[p] = JSON.stringify(task[p]);
                }
            }
            return task;
        }

        if (!wf.name) {
            return callback('Workflow "name" is required');
        }

        if (wf.chain && (
              typeof (wf.chain) !== 'object' ||
              typeof (wf.chain.length) === 'undefined')) {
            return callback('Workflow "chain" must be an array');
        }

        if (!wf.chain) {
            wf.chain = [];
        }

        if (!wf.uuid) {
            wf.uuid = uuid();
        }

        if (typeof (wf.max_attempts) !== 'number') {
            wf.max_attempts = 10;
        }

        if (wf.onError) {
            wf.onerror = wf.onError;
            delete wf.onError;
        }

        if (wf.onerror && (
              typeof (wf.onerror) !== 'object' ||
              typeof (wf.onerror.length) === 'undefined')) {
            return callback('Workflow "onerror" must be an array');
        }

        if (wf.onCancel) {
            wf.oncancel = wf.onCancel;
            delete wf.onCancel;
        }

        if (wf.oncancel && (
              typeof (wf.oncancel) !== 'object' ||
              typeof (wf.oncancel.length) === 'undefined')) {
            return callback('Workflow "oncancel" must be an array');
        }

        wf.chain.forEach(function (task, i, arr) {
            wf.chain[i] = validateTask(task, callback);
        });

        wf.chain_md5 = crypto.createHash('md5').update(
                JSON.stringify(clone(wf.chain))).digest('hex');

        if (wf.onerror) {
            wf.onerror.forEach(function (task, i, arr) {
                wf.onerror[i] = validateTask(task, callback);
            });
            wf.onerror_md5 = crypto.createHash('md5').update(
                    JSON.stringify(clone(wf.onerror))).digest('hex');
        }

        if (wf.oncancel) {
            wf.oncancel.forEach(function (task, i, arr) {
                wf.oncancel[i] = validateTask(task, callback);
            });
            wf.oncancel_md5 = crypto.createHash('md5').update(
                    JSON.stringify(clone(wf.oncancel))).digest('hex');
        }

        if (typeof (wf.timeout) !== 'number') {
            wf.timeout = 3600;
        } else if (wf.timeout === 0) {
            delete wf.timeout;
        }

        return backend.createWorkflow(wf, function (err, result) {
            if (err) {
                return callback(err);
            } else {
                return callback(null, wf);
            }
        });

    }
    // Create a queue a Job from the given Workflow:
    //
    // - j - the Job object workflow and extra arguments:
    //   - workflow - (required) UUID of Workflow object to create the job from.
    //   - params - (opt) JSON object, parameters to pass to the job during exec
    //   - target - (opt) String, Job's target, used to ensure that we don't
    //              queue two jobs with the same target and params at once.
    //   - exec_after - (opt) ISO 8601 Date, delay job execution after the
    //                  given timestamp (execute from now when not given).
    //   - num_attempts - (opt) if this job is a retry of another job, this is
    //                    how many attempts have happened before this one.
    // - opts - Object, any additional information to be passed to the backend
    //          when creating a workflow object which are not workflow
    //          properties, like HTTP request ID or other meta information.
    // - callback - f(err, job)
    function job(j, opts, callback) {
        var theJob = { execution: 'queued', chain_results: []};

        if (!j.workflow) {
            return callback('"j.workflow" is required');
        }

        if (typeof (opts) === 'function') {
            callback = opts;
            opts = {};
        }

        return backend.getWorkflow(j.workflow, function (err, wf) {
            var p;
            var q;
            if (err) {
                return callback(err);
            }

            if (Object.keys(wf).length === 0) {
                return callback(
                    'Cannot create a job from an unexisting workflow');
            }

            if (wf.chain.length === 0) {
                return callback(
                  'Cannot queue a job from a workflow without any task');
            }

            for (q in j) {
                if (j !== 'workflow') {
                    theJob[q] = j[q];
                }
            }

            if (!theJob.exec_after) {
                theJob.exec_after = new Date().toISOString();
            }

            if (!theJob.params) {
                theJob.params = {};
            }

            if (!theJob.num_attempts) {
                theJob.num_attempts = 0;
            }

            if (!theJob.uuid) {
                theJob.uuid = uuid();
            }


            for (p in wf) {
                if (p === 'uuid') {
                    theJob.workflow_uuid = wf.uuid;
                } else if (p !== 'chain_md5' && p !== 'onerror_md5') {
                    theJob[p] = wf[p];
                }
            }

            return backend.validateJobTarget(theJob, function (err) {
                if (err) {
                    return callback(err);
                } else {
                    return backend.createJob(theJob, function (err, results) {
                        if (err) {
                            return callback(err);
                        } else {
                            return callback(null, theJob);
                        }
                    });
                }
            });
        });
    }

    return {
        workflow: workflow,
        job: job
    };
};
