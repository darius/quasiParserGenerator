// Options: --free-variable-checker --require --validate

/**
 * Note that this test is a .js file written in ES5.
 */
module.exports = (function(){
  "use strict";

  require('babel');
  require('babel/register');

  var sesshim = require('./src/sesshim.es6');
  var def = sesshim.def;
  require('./test/testbnf.es6');

  return def({});
}());
