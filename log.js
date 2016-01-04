'use strict';

require('colors');

module.exports = {
    DEBUG: function() { if(LOG_LEVEL < 2) return; for(var i = 0; i < arguments.length; i++) { console.log('DEBUG\t'.cyan, arguments[i].toString()); } },
    INFO: function() { if(LOG_LEVEL < 1) return; for(var i = 0; i < arguments.length; i++) { console.log('INFO\t'.green, arguments[i].toString()); } },
    ERROR: function() { for(var i = 0; i < arguments.length; i++) { console.log('ERROR\t'.red, arguments[i].toString()); } }
};

