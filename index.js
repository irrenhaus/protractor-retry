'use strict';

require('colors');
var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');
var sys = require('sys');
var Q = require('q');

var argv = require('yargs')
            .usage('Usage: $0 [-p|--protractor-bin PATH(node_modules/protractor/bin/protractor)] [-t|--timeout SECONDS(0)] [-r|--retry-pause SECONDS(0)] [-m|--max-retries NUM(3)] [-v|--verbose [-v|--verbose]] -- your.js --protractor --args')
            .alias('p', 'protractor-bin')
            .default('protractor-bin', 'node_modules/protractor/bin/protractor')
            .count('verbose')
            .boolean('verbose')
            .alias('v', 'verbose')
            .alias('t', 'timeout')
            .default('timeout', 0)
            .alias('r', 'retry-pause')
            .default('retry-pause', 0)
            .alias('m', 'max-retries')
            .default('max-retries', 3)
            .argv;

var LOG_LEVEL = argv.verbose;
var PROTRACTOR_BIN = path.resolve(argv['protractor-bin']);
var RETRY_FILE = path.resolve('.protractor-retry-specs');

function DEBUG() { if(LOG_LEVEL < 2) return; for(var i = 0; i < arguments.length; i++) { console.log('DEBUG\t'.cyan, arguments[i].toString()); } }
function INFO() { if(LOG_LEVEL < 1) return; for(var i = 0; i < arguments.length; i++) { console.log('INFO\t'.green, arguments[i].toString()); } }
function ERROR() { for(var i = 0; i < arguments.length; i++) { console.log('ERROR\t'.red, arguments[i].toString()); } }

var protractorArgs = argv._.concat(['--params.isRetryRun', 'true']);
var maxRetries = argv['max-retries'];

function parseOutput(stdout, stderr) {
    var outLines = stdout.toString().trim().split('\n');
    var errLines = stderr.toString().trim().split('\n');

    var failuresMarker = /^\*[\s]+Failures[\s]+\*/;
    var failedSpecMarker = /^[0-9]+\)[\s]+(.*)$/;
    var othersMarker = /^\*[\s]+[\w]+[\s]+\*/;

    var failedSpecs = [];

    if(outLines.length <= 0) {
        ERROR('No protractor output found');
        return null;
    }

    // For whatever reason there's always one empty error line...
    if(errLines.length > 1) {
        ERROR('There were errors on STDERR');
        errLines.forEach(function(err) {
            ERROR(err);
        });
        return null;
    }

    for(var i = 0; i < outLines.length; i++) {
        var line = outLines[i].trim();

        if(line.match(failuresMarker)) {
            DEBUG('Found failures marker at line ' + i + ':', line);

            for(i++; i < outLines.length; i++) {
                line = outLines[i].trim();
                
                if(line.match(othersMarker)) {
                    DEBUG('Found marker stopping the failure parsing:', line);
                    break;
                }

                var failedSpecData = line.match(failedSpecMarker);

                if(failedSpecData) {
                    var failedSpecName = failedSpecData[1];
                    INFO('Found failed spec: "' + failedSpecName + '"');
                    failedSpecs.push(failedSpecName);
                }
            }
        }
    }

    return failedSpecs;
}

function runProtractor() {
    if(!fs.existsSync(PROTRACTOR_BIN)) {
        ERROR('Could not find protractor binary at "' + PROTRACTOR_BIN + '"');
        sys.exit(1);
        return;
    }

    var deferred = Q.defer();

    var child = spawn(PROTRACTOR_BIN, protractorArgs);
    var killTimeout;

    var stdout = [];
    var stderr = [];

    if(argv.timeout > 0) {
        killTimeout = setTimeout(function() {
            killTimeout = null;
            child.kill();
        }, argv.timeout * 1000);
    }

    child.stdout.on('data', function(data) {
        process.stdout.write(data.toString());
        stdout.push(data);
    });

    child.stderr.on('data', function(data) {
        process.stderr.write(data.toString());
        stderr.push(data);
    });

    child.on('exit', function(exitCode) {
        INFO('Protractor is done');
        DEBUG('Child exited with exitCode ' + exitCode);

        if(killTimeout) {
            DEBUG('Clearing kill timeout');
            clearTimeout(killTimeout);
        } else if(killTimeout === null) {
            ERROR('Protractor runtime exceeded the timeout of ' + argv.timeout + ' seconds and had to be killed.');
            deferred.fulfill(null);
            return;
        }

        if(exitCode !== 0 && exitCode !== 1) {
            deferred.fulfill(null);
        }

        deferred.fulfill(parseOutput(Buffer.concat(stdout), Buffer.concat(stderr)));
    });

    return deferred.promise;
}

function runTests() {
    maxRetries--;
    if(maxRetries < 0) {
        ERROR('Maximum number of retries (' + argv['max-retries'] + ') exceeded without success');
        DEBUG('Deleting ' + RETRY_FILE);
        fs.unlinkSync(RETRY_FILE);
        sys.exit(2);
    }

    INFO('Doing Protractor run #' + (argv['max-retries'] - maxRetries));
    return runProtractor().then(function(failedSpecs) {
        if(failedSpecs === null) {
            INFO('There was an error parsing the Protractor output. Retrying...');
        } else {
            INFO('Identified ' + failedSpecs.length + ' failed specs which will be retried');
        }

        if(failedSpecs.length === 0) {
            DEBUG('No failed specs found, Protractor run was successfull');
            return;
        }

        DEBUG('Writing retry file at ' + RETRY_FILE);
        fs.writeFileSync(RETRY_FILE, failedSpecs.join('\n'));

        if(argv['retry-pause'] > 0) {
            INFO('Waiting for ' + argv['retry-pause'] + ' seconds before the next run');
        }

        return Q.delay(argv['retry-pause']).then(function() {
            INFO('Retrying failed specs...');
            return runTests();
        });
    }, function(err) {
        ERROR('An error was thrown');
        ERROR(err.stack);
        DEBUG('Deleting ' + RETRY_FILE);
        fs.unlinkSync(RETRY_FILE);
        sys.exit(3);
    });
}

// This won't be in the same process as the above code!
function installJasmineSpecFilter() {
    var originalFilter = jasmine.getEnv().specFilter;
    var retrySpecs;
    try {
        retrySpecs = fs.readFileSync(RETRY_FILE).toString().split('\n');
    } catch(e) {
        // No such file
        if(browser.params.isRetryRun) {
            console.log('protractor-retry: No retrySpecs file found at ' + RETRY_FILE + ', allowing all specs');
        }
    }

    // This only enables specs which are listed in the RETRY_FILE file
    jasmine.getEnv().specFilter = function(spec) {
        if(!browser.params.isRetryRun || retrySpecs === undefined) {
            return originalFilter ? originalFilter(spec) : true;
        }

        for(var i = 0; i < retrySpecs.length; i++) {
            if(retrySpecs[i].toLowerCase() === spec.getFullName().toLowerCase()) {
                console.log('Found filtered spec ' + spec.getFullName() + '. Allowing by original filter.');
                return originalFilter ? originalFilter(spec) : true;
            }
        }

        console.log('protractor-retry: Removing spec ' + spec.getFullName() + ' from the list of active specs');

        return false;
    };
}

module.exports = {
    runWithRetry: runTests,
    installSpecFilter: installJasmineSpecFilter
};
