// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util'),
    test = require('tap').test,
    uuid = require('uuid'),
    fork = require('child_process').fork;

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


test('unkown message', function (t) {
    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ifError(msg.job);
        t.ok(msg.error);
        t.equal(msg.error, 'unknown message');
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code, signal) {
        t.end();
    });

    child.send({
        foo: 'bar'
    });

});


test('message without job', function (t) {
    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ifError(msg.job);
        t.ok(msg.error);
        t.equal(msg.error, 'unknown message');
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    child.send({
        task: {}
    });
});

test('message without task', function (t) {
    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ifError(msg.job);
        t.ok(msg.error);
        t.equal(msg.error, 'unknown message');
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    child.send({
        job: {}
    });
});

test('message with invalid task', function (t) {
    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ifError(msg.job);
        t.ok(msg.error);
        t.ok(msg.error.match(/opt\.task\.body/));
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    child.send({
        job: {},
        task: {}
    });
});

test('message with successful task', function (t) {
    task.body = function (job, cb) {
        return cb(null);
    }.toString();

    job.chain.push(task);

    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ifError(msg.error);
        t.ok(msg.result);
        t.equal(msg.cmd, 'run');
        t.ok(msg.job);
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    child.send({
        job: job,
        task: task
    });
});

test('message with failed task', function (t) {
    task.body = function (job, cb) {
        return cb('Task body error');
    }.toString();

    job.chain.push(task);

    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ok(msg.error);
        t.ifError(msg.result);
        t.equal(msg.cmd, 'error');
        t.ok(msg.job);
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    child.send({
        job: job,
        task: task
    });
});


test('cancel message', function (t) {
    task.body = function (job, cb) {
        job.timer = 'Timeout set';
        setTimeout(function () {
            // Should not be called:
            return cb(null);
        }, 1550);
    }.toString();
    task.retry = 2;
    task.timeout = 1;

    job.chain.push(task);

    var child = fork(__dirname + '/../lib/child.js');

    child.on('message', function (msg) {
        t.ok(msg.error);
        t.equal(msg.error, 'cancel');
        t.ifError(msg.result);
        t.equal(msg.cmd, 'cancel');
        t.ok(msg.job);
        if (child.exitCode === null) {
            child.kill();
        }
    });

    child.on('exit', function (code) {
        t.end();
    });

    setTimeout(function () {
        child.send({
            cmd: 'cancel'
        });
    }, 750);

    child.send({
        job: job,
        task: task
    });

});
