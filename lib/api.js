// Copyright 2014 Pedro P. Candel <kusorbox@gmail.com> All rights reserved.
var restify = require('restify');
var util = require('util');
var uuid = require('uuid');
var path = require('path');
var fs = require('fs');
var os = require('os');
var trace_event = require('trace-event');
var vm = require('vm');
var Logger = require('bunyan');
var Factory = require('../lib/index').Factory;


var API = module.exports = function (opts) {
    if (typeof (opts) !== 'object') {
        throw new TypeError('opts (Object) required');
    }

    if (typeof (opts.backend) !== 'object') {
        throw new TypeError('opts.backend (Object) required');
    }

    if (typeof (opts.api) !== 'object') {
        throw new TypeError('opts.api (Object) required');
    }

    var log;

    if (opts.log) {
        log = opts.log({
            component: 'workflow-api'
        });
    } else {
        if (!opts.logger) {
            opts.logger = {};
        }

        opts.logger.name = 'workflow-api';
        opts.logger.serializers = restify.bunyan.serializers;

        opts.logger.streams = opts.logger.streams || [ {
            level: 'info',
            stream: process.stdout
        }];

        log = opts.api.Logger = new Logger(opts.logger);
    }

    opts.api.name = opts.api.name || 'WorkflowAPI';
    opts.api.acceptable = ['application/json'];

    if (!opts.api.port && !opts.api.path) {
        opts.api.path = '/tmp/' + uuid();
    }

    opts.api.log = log;
    var server = restify.createServer(opts.api);
    var Backend = require(opts.backend.module);
    opts.backend.opts.log = log;
    var backend = Backend(opts.backend.opts);
    var factory = Factory(backend);

    // Define path and versioned routes:
    var WORKFLOWS_PATH = '/workflows';
    var WORKFLOW_PATH = WORKFLOWS_PATH + '/:uuid';
    var WORKFLOWS_ROUTE = {
        path: WORKFLOWS_PATH,
        version: '0.1.0'
    };
    var WORKFLOW_ROUTE = {
        path: WORKFLOW_PATH,
        version: '0.1.0'
    };

    var JOBS_PATH = '/jobs';
    var JOB_PATH = JOBS_PATH + '/:uuid';
    var JOBS_ROUTE = {
        path: JOBS_PATH,
        version: '0.1.0'
    };
    var SNAP_PATH = '/snapshot';
    var SNAP_ROUTE = {
        path: SNAP_PATH,
        version: '0.1.0'
    };
    var STATS_PATH = '/stats';
    var STATS_ROUTE = {
        path: STATS_PATH,
        version: '0.1.0'
    };
    var JOB_ROUTE = {
        path: JOB_PATH,
        version: '0.1.0'
    };
    var JOB_INFO_PATH = JOB_PATH + '/info';
    var JOB_INFO_ROUTE = {
        path: JOB_INFO_PATH,
        version: '0.1.0'
    };
    var JOB_CANCEL_PATH = JOB_PATH + '/cancel';
    var JOB_CANCEL_ROUTE = {
        path: JOB_CANCEL_PATH,
        version: '0.1.0'
    };
    var JOB_RESUME_PATH = JOB_PATH + '/resume';
    var JOB_RESUME_ROUTE = {
        path: JOB_RESUME_PATH,
        version: '0.1.0'
    };

    var PING_PATH = '/ping';
    var PING_ROUTE = {
        path: PING_PATH,
        version: '0.1.0'
    };

    server.use(restify.requestLogger());

    var EVT_SKIP_ROUTES = {
        'getping010': true
    };
    server.use(function (req, res, next) {
        req.trace = trace_event.createBunyanTracer({
            log: req.log
        });
        if (!EVT_SKIP_ROUTES[req.route.name]) {
            req.trace.begin(req.route.name);
        }
        next();
    });
    server.on('after', function (req, res, route, err) {
        if (req.route && !EVT_SKIP_ROUTES[req.route.name]) {
            req.trace.end(req.route.name);
        }
    });

    server.use(restify.acceptParser(server.acceptable));
    server.use(restify.dateParser());
    server.use(restify.queryParser());
    server.use(restify.bodyParser({
        overrideParams: true,
        mapParams: true
    }));
    server.use(restify.fullResponse());

    server.acceptable.unshift('application/json');

    // Return Service Unavailable if backend is not connected
    server.use(function ensureBackendConnected(req, res, next) {
        if (typeof (backend.connected) !== 'undefined' &&
            backend.connected === false) {
            return next(new restify.ServiceUnavailableError(
                'Backend not connected'));
        }

        return next();
    });

    // Write useful x-* headers
    server.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });
        next();
    });

    // Audit all requests, don't log response bodies for GETs
    server.on('after', function (req, res, route, err) {
        var method = req.method;
        var path = req.path();
        if (method === 'GET' || method === 'HEAD') {
            if (path === '/ping') {
                return;
            }
        }
        // Successful GET res bodies are uninteresting and big.
        var body = !(method === 'GET' &&
            Math.floor(res.statusCode / 100) === 2);

        var timers = {};
        (req.timers || []).forEach(function (time) {
                var t = time.time;
                var _t = Math.floor((1000000 * t[0]) +
                                    (t[1] / 1000));
                timers[time.name] = _t;
        });

        restify.auditLogger({
            log: req.log.child({ route: route }, true),
            body: body,
            timers: timers
        })(req, res, route, err);
    });

    // Define handlers:
    function listWorkflows(req, res, next) {
        backend.getWorkflows(req.params, function (err, workflows) {
            if (err) {
                if (err.toRestError) {
                    return next(err.toRestError);
                } else {
                    return next(new restify.InternalError(err));
                }
            }
            res.send(200, workflows);
            return next();
        });
    }

    function postWorkflow(req, res, next) {
        var workflow = {};
        var wf_members = ['name', 'uuid', 'timeout', 'chain', 'onerror',
                          'max_attempts', 'initial_delay', 'max_delay',
                          'oncancel'];
        var error;
        var meta = {};

        if (typeof (opts.api.wf_extra_params) !== 'undefined') {
            wf_members = wf_members.concat(opts.api.wf_extra_params);
        }

        // Up to the user if want to identify the workflow
        // with self.cooked uuid:
        wf_members.forEach(function (p) {
            if (req.params[p]) {
                workflow[p] = req.params[p];
            }
        });

        if (workflow.chain) {
            workflow.chain.forEach(function (task, i, arr) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
                task.body = vm.runInNewContext('(' + task.body + ')', {});
                if (task.fallback) {
                    task.fallback =
                        vm.runInNewContext('(' + task.fallback + ')', {});
                }
                workflow.chain[i] = task;
            });
        }

        if (workflow.onerror) {
            workflow.onerror.forEach(function (task, i, arr) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
                task.body = vm.runInNewContext('(' + task.body + ')', {});
                if (task.fallback) {
                    task.fallback =
                        vm.runInNewContext('(' + task.fallback + ')', {});
                }
                workflow.onerror[i] = task;
            });
        }

        if (workflow.oncancel) {
            workflow.oncancel.forEach(function (task, i, arr) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
                task.body = vm.runInNewContext('(' + task.body + ')', {});
                if (task.fallback) {
                    task.fallback =
                        vm.runInNewContext('(' + task.fallback + ')', {});
                }
                workflow.oncancel[i] = task;
            });
        }

        if (error) {
            return next(error);
        }

        if (req.headers['request-id']) {
            meta.req_id = req.headers['request-id'];
        }

        return factory.workflow(workflow, meta, function (err, result) {
            if (err) {
                return next(err.toRestError);
            }
            res.header('Location', req.path() + '/' + result.uuid);
            // If Request-Id hasn't been set, we'll set it to workflow UUID:
            if (!req.headers['request-id']) {
                res.header('request-id',  result.uuid);
            }

            res.send(201, result);
            return next();
        });
    }

    function getWorkflow(req, res, next) {
        // If Request-Id hasn't been set, we'll set it to workflow UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }

        var meta = {
            req_id: req.id
        };

        backend.getWorkflow(req.params.uuid, meta, function (err, workflow) {
            if (err) {
                return next(err.toRestError);
            } else {
                res.send(200, workflow);
                return next();
            }
        });
    }

    function updateWorkflow(req, res, next) {
        var error, meta = {};
        // If Request-Id hasn't been set, we'll set it to workflow UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }

        meta.req_id = req.id;

        if (req.params.chain) {
            req.params.chain.forEach(function (task) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
            });
        }

        if (req.params.onerror) {
            req.params.onerror.forEach(function (task) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
            });
        }

        if (req.params.oncancel) {
            req.params.oncancel.forEach(function (task) {
                if (!task.body) {
                    error = new restify.ConflictError('Task body is required');
                }
            });
        }

        if (error) {
            return next(error);
        }

        return backend.updateWorkflow(req.params, meta,
            function (err, workflow) {
                if (err) {
                    return next(err.toRestError);
                }
                res.send(200, workflow);
                return next();
            });
    }

    function deleteWorkflow(req, res, next) {
        // If Request-Id hasn't been set, we'll set it to workflow UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }

        var meta = {
            req_id: req.id
        };

        backend.getWorkflow(req.params.uuid, function (err, workflow) {
            if (err) {
                return next(err.toRestError);
            } else {
                return backend.deleteWorkflow(workflow, meta,
                  function (err, deleted) {
                    if (err) {
                        return next(new restify.InternalError(err));
                    }

                    if (deleted) {
                        res.send(204);
                        return next();
                    } else {
                        return next(new restify.InternalError(
                            'Cannot delete the workflow'));
                    }
                });
            }
        });
    }

    function listJobs(req, res, next) {
        var exec_values =
          ['queued', 'failed', 'succeeded', 'running', 'canceled'],
            cb = function (err, jobs, count) {
                if (err) {
                    if (err.toRestError) {
                        return next(err.toRestError);
                    } else {
                        return next(new restify.InternalError(err));
                    }
                }
                if (count) {
                    res.header('x-count', count);
                }
                res.send(200, jobs);
                return next();
            };

        if (req.params.execution) {
            if (exec_values.indexOf(req.params.execution) === -1) {
                return next(new restify.ConflictError(
                  'Execution must be one of queued, failed, ' +
                  'succeeded, canceled or running'));
            }
        }

        if (req.params.offset) {
            req.params.offset = Number(req.params.offset);
        }

        if (req.params.limit) {
            req.params.limit = Number(req.params.limit);
        }

        return backend.getJobs(req.params, cb);
    }


    function snapshot(req, res, next) {
        return backend.getJobs(function (err, jobs, count) {
            if (err) {
                if (err.toRestError) {
                    return next(err.toRestError);
                } else {
                    return next(new restify.InternalError(err));
                }
            }
            return backend.getRunners(function (err2, runners) {
                if (err2) {
                    return next(new restify.InternalError(err2));
                }
                return backend.getJobs({
                    execution: 'running'
                }, function (err3, running, running_count) {
                    if (err3) {
                        return next(new restify.InternalError(err3));
                    }
                    return backend.getJobs({
                        execution: 'queued'
                    }, function (err4, queued, queued_count) {
                        if (err4) {
                            return next(new restify.InternalError(err4));
                        }

                        res.header('x-count', count);

                        res.send(200, {
                            service: {
                                name: 'workflow',
                                component: 'jobs',
                                ident: req.headers.host,
                                pid: process.pid
                            },
                            stats: {
                                uptime: process.uptime(),
                                memory: process.memoryUsage(),
                                total_jobs: count,
                                running_jobs: running_count,
                                queued_jobs: queued_count
                            },
                            types: [ 'jobs',
                                'runners',
                                'running_jobs',
                                'queued_jobs'],
                            jobs: jobs,
                            running_jobs: running,
                            queued_jobs: queued,
                            runners: runners
                        });
                        return next();
                    });
                });
            });
        });
    }


    function stats(req, res, next) {
        return backend.countJobs(function (err, stats) {
            if (err) {
                return next(new restify.InternalError(err));
            }

            res.send(200, stats);
            return next();
        });
    }


    function postJob(req, res, next) {
        var job = {
            params: {}
        };
        var meta = {};
        var members = ['exec_after', 'workflow', 'target', 'num_attempts',
                        'uuid', 'locks'];

        var job_members = [];
        if (typeof (opts.api.job_extra_params) !== 'undefined') {
            job_members = opts.api.job_extra_params;
        }

        Object.keys(req.params).forEach(function (p) {
            if (members.indexOf(p) !== -1) {
                job[p] = req.params[p];
            } else if (job_members.indexOf(p) !== -1) {
                job[p] = req.params[p];
                // We are adding them here too due to back-compat reasons:
                job.params[p] = req.params[p];
            } else {
                job.params[p] = req.params[p];
            }
        });

        if (req.headers['request-id']) {
            meta.req_id = req.headers['request-id'];
        }

        factory.job(job, meta, function (err, result) {
            if (err) {
                if (typeof (err) === 'string') {
                    return next(new restify.ConflictError(err));
                } else {
                    return next(err.toRestError);
                }
            }
            // If Request-Id hasn't been set, we'll set it to job UUID:
            if (!req.headers['request-id']) {
                res.header('request-id',  result.uuid);
            }
            res.header('Location', req.path() + '/' + result.uuid);
            res.status(201);
            res.send(result);
            return next();
        });
    }

    function getJob(req, res, next) {
        // If Request-Id hasn't been set, we'll set it to job UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }
        var meta = {
            req_id: req.id
        };

        backend.getJob(req.params.uuid, meta, function (err, job) {
            if (err) {
                return next(err.toRestError);
            } else {
                res.send(200, job);
                return next();
            }
        });
    }

    function getInfo(req, res, next) {
        // If Request-Id hasn't been set, we'll set it to job UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }

        var meta = {
            req_id: req.id
        };

        backend.getInfo(req.params.uuid, meta, function (err, info) {
            if (err) {
                return next(err.toRestError);
            } else {
                res.send(200, info);
                return next();
            }
        });
    }

    function postInfo(req, res, next) {
        var info = {}, meta = {};
        Object.keys(req.params).forEach(function (p) {
            if (p !== 'uuid') {
                info[p] = req.params[p];
            }
        });
        // If Request-Id hasn't been set, we'll set it to job UUID:
        if (!req.headers['request-id']) {
            res.header('request-id',  req.params.uuid);
        }

        meta.req_id = req.id;

        backend.addInfo(req.params.uuid, info, meta, function (err) {
            if (err) {
                return next(err.toRestError);
            } else {
                res.send(200);
                return next();
            }
        });
    }

    function cancelJob(req, res, next) {
        var meta = {};
        backend.getJob(req.params.uuid, function (err, job) {
            if (err) {
                return next(err.toRestError);
            } else if (job.execution === 'succeeded' ||
                            job.execution === 'failed') {
                return next(new restify.ConflictError(
                  'Finished jobs cannot be canceled'));
            } else {
                // If Request-Id hasn't been set, we'll set it to job UUID:
                if (!req.headers['request-id']) {
                    res.header('request-id',  req.params.uuid);
                }
                meta.req_id = req.id;

                return backend.updateJobProperty(
                  job.uuid,
                  'execution',
                  'canceled',
                  meta,
                  function (err) {
                    if (err) {
                        return next(new restify.InternalError(err));
                    }
                    job.execution = 'canceled';
                    log.info('Job %s canceled', req.params.uuid);
                    res.send(200, job);
                    return next();
                  });
            }
        });
    }

    // Accepts 'error' and 'result' params. When nothing is given, assumes
    // result is 'OK' and moves forward. When error is given, it means the
    // remote process failed, and the job will be finished with 'failed'
    // execution. Otherwise, chain_results for the task which put the job to
    // wait will be updated with the given result, and the job will be resumed
    // (re-queued, so it gets picked by the runner when there are free slots).
    function resumeJob(req, res, next) {
        var meta = {};
        backend.getJob(req.params.uuid, function (err, job) {
            if (err) {
                return next(err.toRestError);
            } else if (job.execution !== 'waiting') {
                return next(new restify.ConflictError(
                  'Only waiting jobs can be resumed'));
            } else {
                // If Request-Id hasn't been set, we'll set it to job UUID:
                if (!req.headers['request-id']) {
                    res.header('request-id',  req.params.uuid);
                }
                meta.req_id = req.id;

                job.execution = (req.params.error) ? 'failed' : 'queued';
                var r = job.chain_results[job.chain_results.length - 1];
                r.result = (req.params.result) ? req.params.result :
                    ((req.params.error) ? '' : 'External task: OK');
                r.error = (req.params.error) ? req.params.error: '';
                r.finished_at = new Date().toISOString();
                job.chain_results[job.chain_results.length - 1] = r;

                return backend.updateJob(job, meta, function (err, theJob) {
                    if (err) {
                        return next(new restify.InternalError(err));
                    }
                    log.info('Job %s resumed', req.params.uuid);
                    res.send(200, theJob);
                    return next();
                });
            }
        });
    }
    // --- Routes
    // Workflows:
    server.get(WORKFLOWS_ROUTE, listWorkflows);
    server.head(WORKFLOWS_ROUTE, listWorkflows);
    server.post(WORKFLOWS_ROUTE, postWorkflow);
    // Workflow:
    server.get(WORKFLOW_ROUTE, getWorkflow);
    server.head(WORKFLOW_ROUTE, getWorkflow);
    server.put(WORKFLOW_ROUTE, updateWorkflow);
    server.del(WORKFLOW_ROUTE, deleteWorkflow);
    // Jobs:
    server.get(JOBS_ROUTE, listJobs);
    server.head(JOBS_ROUTE, listJobs);
    server.get(SNAP_ROUTE, snapshot);
    server.head(SNAP_ROUTE, snapshot);
    server.get(STATS_ROUTE, stats);
    server.head(STATS_ROUTE, stats);
    server.post(JOBS_ROUTE, postJob);
    // Job:
    server.get(JOB_ROUTE, getJob);
    server.head(JOB_ROUTE, getJob);
    // Cancel job:
    server.post(JOB_CANCEL_ROUTE, cancelJob);
    // Resume job:
    server.post(JOB_RESUME_ROUTE, resumeJob);
    // Job status info:
    server.get(JOB_INFO_ROUTE, getInfo);
    server.head(JOB_INFO_ROUTE, getInfo);
    server.post(JOB_INFO_ROUTE, postInfo);
    // Ping:
    server.get(PING_ROUTE, function (req, res, next) {
        var data = {
            pid: process.pid
        };

        if (typeof (backend.ping) === 'function') {
            return backend.ping(function (err) {
                if (err) {
                    data.backend = 'down';
                    data.backend_error = err.message;

                    res.send(data);
                    return next();

                } else {
                    data.backend = 'up';
                    res.send(data);
                    return next();
                }
            });
        } else {
            data.backend = 'unknown';
            res.send(data);
            return next();
        }
    });

    return {
        init: function init(onInit, onError) {
            var port_or_path = (!opts.api.port) ?
                               opts.api.path :
                               opts.api.port;
            backend.on('error', function (err) {
                return onError(err);
            });

            backend.init(function () {
                log.info('API backend initialized');
            });

            return server.listen(port_or_path, function () {
                log.info('%s listening at %s', server.name, server.url);
                return onInit();
            });

        },
        // These are properties, maybe it's a good idea to define getters:
        server: server,
        backend: backend,
        log: log
    };
};
