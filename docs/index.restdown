---
title: Node Workflow
logo-color: #aa0000
---

# Overview

If you are building a completely new system composed of many discrete API
applications, each of them with a clearly defined area of responsibility, or
if you are trying to assemble a collaboration channel between a heterogeneous
set of unrelated API applications, you need a means to orchestrate interactions
between these applications.

A workflow is effectively an orchestration. It gives you a way to decompose a
complex series of operations down to a sequence of discrete tasks within a state
machine.

The sequence of tasks is more complex than just a series. Tasks can fail, and
so you need to deal with timeouts, retries, "stuck" flows, and so forth.

One way to define a workflow and its tasks is using an arbitrarily-complex
language. Or you can keep it simple by making some assumptions:

* Code is the definition language.
* Tasks are independent. Can be used into different workflows.
* The only way to communicate between tasks is the workflow. Tasks can add,
  remove or modify properties of the workflow.
* If a task requires a specific property of the workflow to be present, the
  task can fail, or re-schedule itself within the workflow, or ...

The system must be designed with failures in mind. Tasks can fail and, as a
consequence, workflows may fail. You may want to recover from a task failure,
or from a whole workflow failure.

## node-workflow

This package provides a way to define re-usable `workflows` using JSON and run
concrete `jobs` with specific `targets` and `parameters` based on such
`workflows`.

# Terminology

* _Task_: A single discrete operation, such as Send Email.
* _Workflow_: An abstract definition of a sequence of Tasks, including
  transition conditions and branches.
* _Job_: The execution of a workflow. It is an instance of a Workflow,
  containing all the required information to execute itself.

# System components

- A workflow and task **factory** for creating tasks, workflows and queueing
  jobs. Uses node.js.
- Alongside the **factory**, the **Workflow API** allows the creation of tasks,
  workflows and jobs through a REST API, with JSON as the payload.
- A **Status API**, used to check the status of a given job, get information
  about failures, and so forth.
- **Job runners**. These are what actually execute workflows. You can have as
  many runners as you want, and they can live anywhere on the network. Once a
  runner atomically takes a job, that job is flagged with the runner's unique
  identifier - _locked_ - to prevent any other runner from executing it. One
  runner can be composed of multiple associated processes for executing jobs.

The factory talks to a __persistence layer__, and saves workflows and tasks.
Once a Job is created, it's saved with all the information required for its
execution, including the associated tasks' code at the moment of job creation.
This will __avoid any potential problems resulting from the modification of
task code once a Job has already been queued__.

A runner itself may unintentionally go nuts or crash while a job is being
executed, leaving the job with an inappropriated _"running"_ status. When a
runner (re)starts, there shouldn't be any job flagged with that runner's
unique identifier, nor should it have a running status. If that happens, the
first thing a runner must do upon restart is pick any job with such an invalid
state and cancel it.

## Task properties

- Name.
- Code to be executed.
- Timeout.
- Number of retries.
- A fall-back task to be executed if the task fails.


        {
          name: 'A Task',
          timeout: 30,
          retry: 2,
          body: function(job, cb) {
            if (!job.foo) {
              job.foo = true;
              return cb('Foo was not defined');
            }
            return cb(null);
          },
          fallback: function (err, job, cb) {
            job.the_err = err;
            return cb(null);
          }
        }


Note that a task's timeout shouldn't be bigger than the workflow timeout, but
it really doesn't matter. If a task's execution exceeds the workflow timeout, it
will be failed with a 'workflow timeout' error.

## Workflow properties

- Name.
- A 'chain' of tasks to be executed.
- A global timeout.
- An alternate error branch.


        factory.workflow({
          name: 'Sample Workflow',
          chain: [aTask, anotherTask, aTaskWhichWillFail],
          timeout: 300,
          onError: [aFallbackTask]
        }, function(err, workflow) {
          if (err) {
            throw(err);
          }
          return workflow;
        });


### Workflow chain and onerror MD5

Starting with version `0.9.4`, MD5 hashes are calculated for the stringified
version of both the workflow `chain` and the workflow `onerror` members (when
present):


    wf.chain_md5 = crypto.createHash('md5').update(
                JSON.stringify(clone(wf.chain))).digest('hex');

    wf.onerror_md5 = crypto.createHash('md5').update(
                JSON.stringify(clone(wf.onerror))).digest('hex');


Both properties can compared against the version of that code stored in the
backend to detect if any modifications must be performed.

Note these `chain_md5` and `onerror_md5` properties are not propagated into jobs
created from the workflow.

### onCancel optional chain

Since version `0.9.9` it's also possible to add an optional `oncancel` chain of
tasks, which will be run in the case a job is canceled. This chain should be
used just to recover from a possible bad state caused when a given job is
aborted in the middle of its execution.

This `oncancel` property has the same format than `chain` and `onerror`, and
will also have an associated `oncancel_md5` hash for quick content verifycation.

Additionally, the results of the execution of this branch of tasks will be
saved into the jobs' `oncancel_results` property.


## Job properties

While a Workflow is something abstract, a Job can operate on a concrete target.
For example, you can use a REST URI as the target of the job, or an LDAP DN, or
whatever you need to make sure that the same job will not be queued twice.

When jobs are created and queued, they check if another job with the same target
(and the same parameters) exists. If so, the job creation will fail.

Obviously, there are some cases where you may want the same job to be queued
for the same target; for example, POST to a given URI to create a new collection
element. For that reason, a job's `parameters` are also checked with the job's
`target` when creating a new job.

If a job has failed for a given target and parameters, you may want to
create a new job after some time. This is possible since the uniqueness checks
are only made against previous jobs which are "running" "waiting" or "queued",
not versus "finished" jobs (regardless of their result).

Same as the workflow, plus:

- Results for each one of the tasks.
- The job target, when given.
- The job parameters, when necessary.
- The job status (something like "queued", "running", "retried", "finished",
  "waiting"). Note that a job is running while a task is being executed. It's
  possible to change job status to "queued" once a task has been completed, and
  leave the job there to be picked by a runner at some later moment.
- When to run the job. Maybe we want to delay execution in time?.
- Any additional properties a task may want to save with the job, to be used by
  a subsequent task.
- Locks. Optional. A special property containing a string which will be used to
  build a Regular Expression. See below.


        factory.job({
          workflow: aWorkflow,
          exec_after: '2012-01-03T12:54:05.788Z'
        }, function(err, job) {
          if (err) {
            callback(err);
          }
          aJob = job;
          callback(null, job);
        });


### Locking other jobs using `job.lock` property

(Since 0.9.3)

There are some situations where it's not enough to lock jobs solely having the
same parameters and target. For whatever reason, you want to lock the creation
of any job with arbitrary targets. E.g. if you're using a job to backup some
data, you probably don't want anything else modifying or removing that
information.

In these cases, we can provide the `job.lock` property with our job, and set
that value to a string which will be used later to build a regular expression.

For example, let's say we want to prevent the creation of any jobs with a
target of "modify" or "destroy" until our current job has been finished. We can
provide our "backup" job the following property:

    locks: '(modify|destroy)$'

That value will be compared against the targets of any new job we attempt to
create, from the moment we added our "backup" job until it has been finished.
Any attempt to create a new job with a target that matches the above lock will
result in the error:

    'Job target is currently locked by another job'

## Adding extra properties to workflows and jobs through API methods

While it's possible to add any arbitrary property to a workflow or a job
(as far as the backend supports it), API methods filter out unknown attributes.
In order to allow new attributes using the API, you need to specify these as an
Array of attribute names added to the `api` config section, as follows:


    {
        "backend": {
            "module": "..",
            "opts": {
            }
        },
        "api": {
            "port": 8080,
            "wf_extra_params": ["bar"],
            "job_extra_params": ["foo"]
        },
        "runner": { ... }
    }


# Workflow API and REST API.

You can create `workflows` and `jobs` either by using the provided REST API(s),
or by embedding this module's API into your own system(s). The former will be
easier to get up and running, but you should use the latter when:

- You want to use the Worflow API in a node.js application that is not the
  bundled REST API.
- You want to use a different backend storage system, or otherwise change the
  assumptions of the bundled REST API

The package also provides a binary file to run the `WorkflowAPI` using the
same configuration file we pass to our `WorkflowRunner`:

    ./bin/workflow-api path/to/config.json

See [REST API docs](workflowapi.html) for the details of available end-points.

# Workflow Runners

In order to execute `jobs`, at least one `WorkflowRunner` must be up and ready
to take jobs. An arbitrary number of `runners` can be used on any set of
hosts; their configurations must match.

An example `WorkflowRunner` is provided with the package and can be started
with:

    ./bin/workflow-runner path/to/config.json

The system design requires that we can have workflow runners everywhere. As
many as needed, and all of them reporting health periodically.

All runners will periodically query the backend for information about other
runners. If they detect one of those other runners has been inactive for a
configurable period of time, they will check for stale jobs associated with
that inactive runner and cancel those jobs.

The first thing a runner does when it boots is to register itself with the
backend (which is the same as reporting its health). At a configurable interval
a runner will try to pick queued jobs and execute them. Runners will report
activity at this same interval.

Every runner must have a unique identifier, which can either be passed in at the
runner's initialization, or be auto-generated the first time the runner is
created and saved for future runs.

Runners will spawn child processes, one process per job. Max number of child
processes is also configurable.

## How runners pick and execute jobs

A runner will query the backend for queued jobs (exactly the same number of
jobs as available child processes to spawn). Once the runner gets a set of
these queued jobs, it will try to obtain an exclusive lock on each job before
processing it. When a job is locked by a runner, it will not be found by other
runners searching for queued jobs.

Once the runner has an exclusive lock over the job, it'll change job status
from _queued_ to _running_, and begin executing the associated tasks.

In order to execute the job, the runner will spawn a child process, and pass
it all the information about the job; child processes don't have access to
the backend, just to the job, which must be a JSON object.

Note that everything must be executed within the acceptable amount of time
provided for the job. If this time expires, the job execution will fail and
the `onerror` branch will be executed when given.

## Task execution:

A runner will then try to execute the `job` chain of tasks, in order. For every
task, the runner will try to execute the task `body` using the node.js VM API,
effectively as a separate process. Every task will get as arguments the job and
a callback. A task should call the callback once it's completed.



    // A task body:
    function(job, cb) {
      // Task stuff here:
      cb(null);
    }


If a task succeeds, it will call the callback without `error`:

    cb(null);

Otherwise, the task should call the callback with an error message:

    cb('whatever the error reason');

These error messages will be available for the task's `onerror` function, in
order to allow a task's fallback to decide if it can recover the task from a
failure.

It's also possible to set an specific timeout for every task execution.

If a task fails, or if the task timeout is reached, the runner will check if
we've exceeded the number of retries for the task. If that's not the case,
it'll try to execute the task again.

Once the max number of retries for a task has been reached, the runner will
check if the task has a `fallback`. If that's the case, it'll call it with the
error which caused the failure, as follows:

    task.onerror(error, job, cb);

The same logic as for task bodies can be applied to `fallbacks`.

Note that __tasks run sandboxed__. Only the node modules we specify to the
runner at initialization time, alongside with `setTimeout`, `clearTimeout`,
`setInterval` and `clearInterval` global functions, will be available for
task `body` and `fallback` functions (this will be configurable).

All the task results will be saved in order on the job's property
`chain_results`. For every task, the results will be something like:

    {
      error: '',
      results: 'OK'
    }

or, for a task which failed:

    {
      error: 'Whatever the error reason',
      results: ''
    }

If the task fails because its `fallback` failed, or because the task
doesn't have such a fallback, the job's `onerror` chain will be invoked if
present.

The logic to execute the job's `onerror` chain is exactly the same as we've
described here for the main `chain` of tasks.

Once the job is finished, either successfully or right after a failure, or even
in the case a task tells the runner to _re-queue_ the job, the child process
running the job will communicate to runner the results. The runner will save
back those results to the backend, and either finish the job, or re-queue it
for another runner.

## Using tasks to re-queue, retry or put jobs to wait

There are some **special errors** which can be used in task bodies to modify
a job's execution status without making it fail. These are `queue`, `wait`
and `retry`.

If you use any of the aforementioned keywords as the error returned by a task
body, instead of failing the job it'll modify the job's status to either
`queued`, `waiting` or `retried`.

Usually, you may want to re-queue a job together with a modification of the
`exec_after` job property, so its execution will be delayed in time.

Retry can be used at any point in a job before it fails to make another attempt
at running the complete job (not a single task).

Finally, `waiting` is available targeting those cases where a task fires an
action to a third party system, and we don't want to keep polling the remote
system from our task body until such remote action has finished. Instead, we
can simply tell the job to *hold on* until something else tells it to continue.
The remote system can then resume the job making a POST request to
`/jobs/:job_uuid/resume`, which will bring the job status back to `queued`,
and then executed by the runner from where it entered waiting the next time that
runner has slots available.

# Configuration options

The following is an example configuration for node-workflow, with all the
relevant sections included:


    { 
      "backend": {
        "module": "../lib/workflow-redis-backend",
        "opts": {
          "port": 6379,
          "host": "127.0.0.1",
          "db": 14 
        } 
      },
      "api": {
        "port": 8080
      },
      "runner": {
        "identifier": "cd925eef-93fb-4bfe-a820-2aaedf9fc006",
        "forks": 2,
        "do_fork": false,
        "run_interval": 250,
        "sandbox": {
            "modules": {
                "http": "http",
                "uuid": "uuid"
            },
            "foo": "bar",
            "bool": true,
            "aNumber": 5
        }
      },
      "logger": {
        "streams": [ {
          "level": "info",
          "stream": "process.stdout"
        }, {
          "level": "debug",
          "path": "./some-file.log"
        }]
      } 
    }


## Backend

The backend configuration has two main sections: `module` and `opts`. The
`module` value must be something we can use to load the backend module of
choice by issuing `require(backend.module)`. It doesn't matter if it's a node.js
npm module or a relative path to the module. The included module must be a class
which inherits from `WorkflowBackend`.

The `opts` section is anything required by the chosen backend constructor to be
initialized:


    var BackendModule = require(config.backend.module);
    var backend = new BackendModule(config.backend.opts);


Both, API and Runner will communicate with the backend using the configuration
provided on this section.

## API

Anything you want to pass to [restify.createServer](http://mcavage.github.com/node-restify/#Creating-a-Server).
restify's server logger configuration will be the same as you provide for the
logger section.

Note you can pass either a `port` number or a socket `path` here too.

## Runner

The configuration for workflow runners. None of the options in this section is
required.

- `identifier`: the unique identifier for a runner. If none is given, the first
  time a runner is started it will generate an UUID and store it in a file --
  `workflow-runner` -- which will be reused on the subsequent boots.
- `do_fork`: whether or not to fork child processes to run jobs tasks. (`true`
  by default).
- `forks`: the maximum number of jobs to run in parallel by this runner. (The
  default is ten). Will also match the number of child processes to be forked
  by the runner when the option `do_fork` is either not set or `true`.
- `run_interval`: Integer. Time __in milliseconds__ for the runner to: report it
  is active to the backend, search for new queued jobs to process, and search for
  _stale_ jobs from other runners. Ten times this value is what's used to
  decide if a runner is inactive; if a runner hasn't reported it's healthy since
  `10 * run_interval`, it'll be considered inactive by other runners, and all
  associated jobs will be canceled. The default `run_interval` is 250 milliseconds
  after the previous execution.
- `sandbox`: any variables and node.js modules we want to make available for the
  VM where we run our tasks. The key for each member will be the identifier for 
  referring to each object inside a task's `body` and `fallback` functions,
  while the value is what the system will use to require the module.
  For example: `{uuid: 'uuid'}`.

  Remember that, by default, only [global node timers](http://nodejs.org/docs/latest/api/timers.html)
  will be available for tasks if nothing is given.

## Logger

Any streams you want to pass to [node-bunyan](https://github.com/trentm/node-bunyan#readme),
used by both `Runners` and `REST API`.

# Demo

The [workflow-example](https://github.com/kusor/node-workflow-example)
repository contains everything needed to illustrate:

- An example config file `config.json.sample` which should be renamed to 
  `config.json`, and modified to properly match your local environment.

Remember that, in order to process any `job` the `workflow-runner` needs to be
initialized pointing to the aforementioned configuration file:

    ./node_modules/.bin/workflow-runner config.json

Also, in order to be able to run the API-based example mentioned below, the
`workflow-api` HTTP server needs to be up and running too:

    ./node_modules/.bin/workflow-api config.json

Contents for the other files within the [workflow-example](https://github.com/kusor/node-workflow-example)
repository are:

- An example of how to use node-workflow as a node module in order to create
  workflows, queue jobs and wait for the results. See `module.js`.
- An example of how to achieve the same goal using the Workflow API instead of
  the node module. See `api.js`.
- Both examples share the same workflow definition, contained in the file
  `shared-workflow.js`. The beginning of the aforementioned files
  can be useful to understand the differences when trying to create a workflow
  using these different approaches.
- Finally, this directory also contains the file `node.js`, which does
  exactly the same thing as the workflow/job does -- create and star a gist
  using your github's username and password -- but straight from node.js. This
  file is useful in order to understand the differences between writing code
  to be executed by node.js directly, and using it to create workflows and the
  associated tasks. Remember, code within tasks runs sandboxed using
  [Node's VM API](http://nodejs.org/docs/latest/api/vm.html) and that tasks
  are totally independent.

See also `example.js` for more options when defining workflows and the different
possibilities for task fallbacks, retries, timeouts, ...


# LICENSE

The MIT License (MIT) Copyright (c) 2014 Pedro Palazón Candel

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

<style>#forkongithub a{background:#600;color:#fff;text-decoration:none;font-family:arial, sans-serif;text-align:center;font-weight:bold;padding:5px 40px;font-size:1rem;line-height:2rem;position:relative;transition:0.5s;}#forkongithub a:hover{background:#000;color:#fff;}#forkongithub a::before,#forkongithub a::after{content:"";width:100%;display:block;position:absolute;top:1px;left:0;height:1px;background:#fff;}#forkongithub a::after{bottom:1px;top:auto;}@media screen and (min-width:800px){#forkongithub{position:absolute;display:block;top:0;right:0;width:200px;overflow:hidden;height:200px;}#forkongithub a{width:200px;position:absolute;top:60px;right:-60px;transform:rotate(45deg);-webkit-transform:rotate(45deg);box-shadow:4px 4px 10px rgba(0,0,0,0.8);}}</style><span id="forkongithub"><a href="https://github.com/kusor/node-workflow">Fork me on GitHub</a></span>
