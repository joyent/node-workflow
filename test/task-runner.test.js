// Copyright 2014 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util'),
    test = require('tap').test,
    uuid = require('uuid'),
    WorkflowTaskRunner = require('../lib/task-runner');

var job = {
    timeout: 180,
    workflow_uuid: 'bdfa0821-5071-4682-b965-88293149a8d2',
    name: 'A workflow name',
    exec_after: '2012-01-03T12:54:05.788Z',
    params: {
        'a': '1',
        'b': '2'
    },
    uuid: 'fb4c202d-19ed-4ed9-afda-8255aa7f38ad',
    target: '/foo/bar',
    execution: 'running',
    chain_results: [],
    chain: [],
    onerror: []
};

var task = {
    'uuid': uuid(),
    'name': 'A name',
    'body': 'Fake body'
};


var sandbox = {
    'modules': {
        'http': 'http',
        'uuid': 'uuid',
        'restify': 'restify'
    },
    'foo': 'bar',
    'bool': true,
    'aNumber': 5,
    'someError': new Error('some error')
};

test('throws on missing opts', function (t) {
    t.throws(function () {
        return WorkflowTaskRunner();
    }, new TypeError('opts (Object) required'));
    t.end();
});


test('throws on missing opts.job', function (t) {
    t.throws(function () {
        return WorkflowTaskRunner({});
    }, new TypeError('opts.job (Object) required'));
    t.end();
});


test('throws on missing opts.task', function (t) {
    t.throws(function () {
        return WorkflowTaskRunner({job: job});
    }, new TypeError('opts.task (Object) required'));
    t.end();
});


test('throws on incorrect opts.sandbox', function (t) {
    t.throws(function () {
        return WorkflowTaskRunner({
            job: job,
            task: task,
            sandbox: 'foo'
        });
    }, new TypeError('opts.sandbox must be an Object'));
    t.end();
});


test('throws on opts.task.body not a function', function (t) {
    t.throws(function () {
        return WorkflowTaskRunner({
            job: job,
            task: task
        });
    }, new TypeError('opt.task.body (String) must be a Function source'));
    task.body = '5 === 5';
    t.throws(function () {
        return WorkflowTaskRunner({
            job: job,
            task: task
        });
    }, new TypeError('opt.task.body (String) must be a Function source'));
    t.end();
});


test('a task which succeeds on 1st retry', function (t) {
    task.body = function (job, cb) {
        return cb(null);
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'run');
        t.equal(msg.task_name, task.name);
        t.end();
    });

});


test('sandbox modules and variables', function (t) {
    // Or javascriptlint will complain regarding undefined variables:
    var foo, bool, aNumber, restify, info, someError;
    var task_body = function (job, cb) {
        if (typeof (uuid) !== 'function') {
            return cb('uuid module is not defined');
        }
        if (typeof (foo) !== 'string') {
            return cb('sandbox value is not defined');
        }
        if (typeof (bool) !== 'boolean') {
            return cb('sandbox value is not defined');
        }
        if (typeof (aNumber) !== 'number') {
            return cb('sandbox value is not defined');
        }
        if (typeof (restify.createJsonClient) !== 'function') {
            return cb('restify.createJsonClient is not defined');
        }
        if (typeof (info) !== 'function') {
            return cb('sandbox info() is not defined');
        }
        var client = restify.createJsonClient({
            url: 'http://127.0.0.1'
        });
        if (typeof (client.url) !== 'object') {
            return cb('restify is defined but cannot create a client');
        }
        if (!(someError instanceof Error)) {
            return cb('"Error" JavaScript builtin object is not shared with ' +
                'sandbox');
        }
        return cb(null);
    };

    task.body = task_body.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task,
        sandbox: sandbox
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'run');
        t.equal(msg.task_name, task.name);
        t.end();
    });

});


test('a task which succeeds on 2nd retry', function (t) {
    task.body = function (job, cb) {
        if (!job.foo) {
            job.foo = true;
            return cb('Foo was not defined');
        }
        return cb(null);
    }.toString();
    task.retry = 2;
    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.ok(msg.job.foo);
        t.equal(msg.cmd, 'run');
        t.equal(msg.task_name, task.name);
        t.end();
    });
});


test('a task which fails and has no "fallback"', function (t) {
    task.body = function (job, cb) {
        return cb('Task body error');
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ifError(msg.result);
        t.equal(msg.error, 'Task body error', 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'error');
        t.equal(msg.task_name, task.name);
        t.end();
    });
});


test('a task which fails and succeeds "fallback"', function (t) {
    task.fallback = function (err, job, cb) {
        job.the_err = err;
        return cb(null);
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');
    t.equal(typeof (wf_task_runner.fallback), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.job.the_err, 'Task body error');
        t.equal(msg.cmd, 'run');
        t.end();
    });
});


test('a task which fails and "fallback" fails too', function (t) {
    task.fallback = function (err, job, cb) {
        return cb('fallback error');
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');
    t.equal(typeof (wf_task_runner.fallback), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ifError(msg.result);
        t.equal(msg.error, 'fallback error', 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'error');
        t.end();
    });
});


test('a task which fails after two retries and has no "fallback"',
    function (t) {
        task.body = function (job, cb) {
            if (!job.bar) {
                job.bar = true;
                return cb('Bar was not defined');
            } else if (!job.baz) {
                job.baz = true;
                return cb('Baz was not defined');
            }
            // Should not be called
            return cb(null);
        }.toString();
        task.fallback = null;

        job.chain.push(task);

        var wf_task_runner = WorkflowTaskRunner({
            job: job,
            task: task
        });

        t.ok(wf_task_runner.name);
        t.equal(typeof (wf_task_runner.body), 'function');

        wf_task_runner.runTask(function (msg) {
            t.ifError(msg.result);
            t.equal(msg.error, 'Baz was not defined', 'task error');
            t.ok(msg.job, 'job ok');
            t.ok(msg.job.bar, 'job.bar ok');
            t.ok(msg.job.baz, 'job.baz ok');
            t.equal(msg.cmd, 'error', 'job cmd ok');
            t.end();
        });
    });


test('a task which time out and succeeds "fallback"', function (t) {
    task.body = function (job, cb) {
        setTimeout(function () {
            // Should not be called:
            return cb('Error within timeout');
        }, 1050);
    }.toString();
    task.fallback = function (err, job, cb) {
        job.the_err = err;
        return cb(null);
    }.toString();
    task.timeout = 1;
    task.retry = 1;

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');
    t.equal(typeof (wf_task_runner.fallback), 'function');

    t.equal(wf_task_runner.timeout, 1000);

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.job.the_err, 'task timeout error');
        t.equal(msg.cmd, 'run');
        t.end();
    });
});


test('a task which times out and fallback does too', function (t) {
    task.body = function (job, cb) {
        job.timer = 'Timeout set';
        setTimeout(function () {
            // Should not be called:
            return cb(null);
        }, 1050);
    }.toString();
    task.retry = 1;
    task.fallback = function (err, job, cb) {
        job.fbtimer = 'Fallback timeout set';
        setTimeout(function () {
            // Should not be called:
            return cb(null);
        }, 1025);
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name, 'uuid ok');
    t.equal(typeof (wf_task_runner.body), 'function', 'body ok');
    t.equal(typeof (wf_task_runner.fallback), 'function', 'fallback ok');
    t.equal(wf_task_runner.timeout, 1000, 'timeout ok');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.error, 'task error');
        t.equal(msg.error, 'task timeout error', 'task timeout error');
        t.ifError(msg.result, 'task result');
        t.ok(msg.job, 'job ok');
        t.equal(msg.cmd, 'error', 'cmd ok');
        t.end();
    });
});

test('a task which succeeds and re-queues the workflow', function (t) {
    task.body = function (job, cb) {
        return cb('queue');
    }.toString();
    task.fallback = null;
    task.retry = 1;

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ok(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'queue');
        t.end();
    });

});


test('a task which times out and has no fallback', function (t) {
    task.body = function (job, cb) {
        job.timer = 'Timeout set';
        setTimeout(function () {
            // Should not be called:
            return cb(null);
        }, 1050);
    }.toString();
    task.retry = 1;
    task.fallback = null;
    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name, 'uuid ok');
    t.equal(typeof (wf_task_runner.body), 'function', 'body ok');
    t.equal(wf_task_runner.timeout, 1000, 'timeout ok');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.error, 'task error');
        t.equal(msg.error, 'task timeout error', 'task timeout error');
        t.ifError(msg.result, 'task result');
        t.ok(msg.job, 'job ok');
        t.equal(msg.cmd, 'error', 'cmd ok');
        t.end();
    });

});


test('a task which timeout and is canceled', function (t) {
    task.body = function (job, cb) {
        job.timer = 'Timeout set';
        setTimeout(function () {
            // Should not be called:
            return cb(null);
        }, 1550);
    }.toString();
    task.retry = 2;
    task.fallback = null;
    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name, 'uuid ok');
    t.equal(typeof (wf_task_runner.body), 'function', 'body ok');
    t.equal(wf_task_runner.timeout, 1000, 'timeout ok');

    setTimeout(function () {
        wf_task_runner.canceled = true;
    }, 750);

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.error, 'task error');
        t.equal(msg.error, 'cancel', 'task timeout error');
        t.ifError(msg.result, 'task result');
        t.ok(msg.job, 'job ok');
        t.equal(msg.cmd, 'cancel', 'cmd ok');
        t.end();
    });

});


test('a task which fails and is canceled', function (t) {
    task.body = function (job, cb) {
        setTimeout(function () {
            return cb('Task body error');
        }, 500);
    }.toString();

    task.fallback = function (err, job, cb) {
        job.the_err = err;
        return cb(null);
    }.toString();

    task.retry = 1;

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');
    t.equal(typeof (wf_task_runner.fallback), 'function');

    setTimeout(function () {
        wf_task_runner.canceled = true;
    }, 350);

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.error, 'task error');
        t.equal(msg.error, 'cancel', 'task timeout error');
        t.ifError(msg.result, 'task result');
        t.ok(msg.job, 'job ok');
        t.equal(msg.cmd, 'cancel', 'cmd ok');
        t.end();
    });

});


test('a task which calls job.info', function (t) {
    var info;
    task.body = function (job, cb) {
        job.log.info('an info string');
        info('a second info string');
        return cb(null);
    }.toString();

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    // The callback will be called two times: once for info(),
    // and the 2nd time to finish the task. It will not be called
    // for job.log.info

    var num = 0;

    wf_task_runner.runTask(function (msg) {
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.task_name, task.name);
        num += 1;

        if (num === 1) {
            t.ok(msg.info, 'info present');
            t.notOk(msg.result, 'result not present');
            t.equal(msg.cmd, 'info', 'info cmd');
            t.equal(msg.info, 'a second info string', 'info string');
            return;
        }

        t.ok(msg.result, 'result present');
        t.notOk(msg.info, 'info not present');
        t.equal(msg.cmd, 'run', 'run cmd');
        t.end();
    });

});


// GH-82: Support cb(new Error()) on tasks callbacks to provide useful info,
// the same than when we call with restify.Error() instances:
test('a task which fails with restify.Error', function (t) {
    // Not really needed, already on the sandbox
    var restify = require('restify'),
        wf_task_runner;

    task.body = function (job, cb) {
        var error = new restify.ConflictError('Task body error');
        return cb(error);
    }.toString();

    task.fallback = null;
    task.retry = 1;
    task.timeout = 1000;

    job.chain = [task];

    wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task,
        sandbox: sandbox
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ifError(msg.result);
        t.ok(msg.error);
        t.ok(msg.error.message);
        t.equal(msg.error.message, 'Task body error');
        t.ok(msg.error.statusCode);
        t.equal(msg.cmd, 'error');
        t.equal(msg.task_name, task.name);
        t.end();
    });
});

test('a task which fails with generic (not restify) Error', function (t) {

    task.body = function (job, cb) {
        return cb(new ReferenceError('Task body error'));
    }.toString();

    task.fallback = null;
    task.retry = 1;
    task.timeout = 1000;

    job.chain = [task];

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ifError(msg.result);
        t.ok(msg.error);
        t.ok(msg.error.message);
        t.equal(msg.error.message, 'Task body error');
        t.ok(msg.error.name);
        t.equal(msg.cmd, 'error');
        t.equal(msg.task_name, task.name);
        t.end();
    });
});


test('a task which defines its own modules', function (t) {
    // Or javascriptlint will complain regarding undefined variables:
    var foo, bool, aNumber, restify, http;
    var task_body = function (job, cb) {
        if (typeof (uuid) !== 'function') {
            return cb('uuid module is not defined');
        }
        if (typeof (foo) !== 'string') {
            return cb('sandbox value is not defined');
        }
        if (typeof (bool) !== 'boolean') {
            return cb('sandbox value is not defined');
        }
        if (typeof (aNumber) !== 'number') {
            return cb('sandbox value is not defined');
        }
        if (typeof (restify) !== 'undefined') {
            return cb('restify should be overriden by task modules');
        }
        if (typeof (http) !== 'undefined') {
            return cb('http should be overriden by task modules');
        }
        return cb(null);
    };

    task.body = task_body.toString();
    task.modules = {
        'uuid': 'uuid'
    };

    job.chain.push(task);

    var wf_task_runner = WorkflowTaskRunner({
        job: job,
        task: task,
        sandbox: sandbox
    });

    t.ok(wf_task_runner.name);
    t.equal(typeof (wf_task_runner.body), 'function');

    wf_task_runner.runTask(function (msg) {
        t.ok(msg.result);
        t.ifError(msg.error, 'task error');
        t.ok(msg.job);
        t.equal(msg.cmd, 'run');
        t.equal(msg.task_name, task.name);
        t.end();
    });
});
