// Options: --free-variable-checker --require --validate
module.exports = (function(){
  "use strict";

  const {def} = require('./sesshim.es6');
  const {re} = require('./qregexp.es6');

  const FAIL = def({toString: () => 'FAIL'});
  const EOF = def({toString: () => 'EOF'});
  const LEFT_RECUR = def({toString: () => 'LEFT_RECUR'});


  // JSON compat group. See json.org
  const SPACE_RE = re`\s+`;
  const NUMBER_RE = re`-?\d+(?:\.\d+)?(?:[eE]-?\d+)?`;
  const UCODE_RE = re`\\u[\da-fA-F]{4}`;
  // Note no \' (escaped single quote) in accord with JSON.
  const CHAR_RE = re`[^\"\\]|\\"|\\\\|\\\/|\\b|\\f|\\n|\\r|\\t|${UCODE_RE}`;
  const STRING_RE = re`\"${CHAR_RE}*\"`;
  const IDENT_RE = re`[a-zA-Z_\$][\w\$]*`;

  // Cheap universal-enough token productions for ad hoc DSLs
  const SINGLE_OP = re`[\[\]\(\){},;]`;
  const MULTI_OP = re`[:~@%&+=*<>.?|\\\-\^\/]+`;
  const LINE_COMMENT_RE = re`#.*\n`;


  // Like RE but must match entire string
  function allRE(RE) {
    return re(RE.flags)`^${RE}$`;
  }

  // Matches if it matches any of the argument RegExps
  function anyRE(...REs) {
    return RegExp(REs.map(RE => RE.source).join('|'));
  }

  // Turn RE into a capture group
  function captureRE(RE) {
    return re(RE.flags)`(${RE})`;
  }

  // Like RE but as if the sticky ('y') flag is on.
  // RE itself should have neither the 'y' nor 'g' flag set,
  // and it should not begin with a "^" (start anchor).
  function stickyRE(RE) {
    return RegExp(RE.source, RE.flags + 'y');
  }

  try {
    stickyRE(/x/);
  } catch (er) {
    if (!(er instanceof SyntaxError)) { throw er; }
    // Assume that this platform doesn't support the 'y' flag so we
    // must emulate it
    const superExec = RegExp.prototype.exec;
    stickyRE = function stickyREShim(RE) {
      const result = RegExp(RE.source, RE.flags + 'g');
      result.exec = function stickyExec(str) {
        const start = this.lastIndex;
        const arr = superExec.call(this, str);
        if (!arr) { return arr; }
        if (arr.index !== start) {
          this.lastIndex = 0;
          return null;
        }
        return arr;
      };
      return result;
    };
  }


  // A position of a token in a template of a template string.
  // Ideally, somewhere else there's a sourcemap from the source positions
  // of the template string expression itself to the template itself, though
  // this does not exist yet.
  class Pos {
    constructor(segmentNum, start, after) {
      this.segmentNum = segmentNum;
      this.start = start;
      this.after = after;
      def(this);
    }
    toString() { return `#${this.segmentNum}@${this.start}:${this.after}`; }
  }

  class Token {
    constructor(text, pos) {
      this.text = text;
      this.pos = pos;
      def(this);
    }
    toString() { return `${JSON.stringify(this.text)} at ${this.pos}`; }

    static tokensInSegment(segmentNum, segment, RE) {
      RE = stickyRE(RE);
      let expectedIndex = 0;
      RE.lastIndex = 0;
      const result = [];

      while (RE.lastIndex < segment.length) {
        const arr = RE.exec(segment);
        if (arr === null) {
          const badTok =
              new Token(segment.slice(RE.lastIndex),
                        new Pos(segmentNum, RE.lastIndex, segment.length));
          throw new SyntaxError(`Unexpected: ${badTok}`);
        }
        const text = arr[1];
        const actualStart = RE.lastIndex - text.length;
        const tok = new Token(text,
                              new Pos(segmentNum, actualStart, RE.lastIndex));
        if (expectedIndex !== actualStart) {
          throw new Error(`Internal: ${tok} expected at ${expectedIndex}`);
        }
        result.push(tok);
        expectedIndex = RE.lastIndex;
      }
      return def(result);
    }

    // Interleaved token records extracted from the segments of the
    // template, and bare hole numbers representing the gap between
    // templates.
    static tokensInTemplate(template, RE) {
      const numSubs = template.length - 1;
      const result = [];
      for (let segnum = 0; segnum <= numSubs; segnum++) {
        result.push(...this.tokensInSegment(segnum, template[segnum], RE));
        if (segnum < numSubs) {
          result.push(segnum); // bare hole number
        }
      }
      return result;
    }

    static prettyTemplate(template) {
      const numSubs = template.length - 1;
      const result = [];
      for (let segnum = 0; segnum <= numSubs; segnum++) {
        result.push(template[segnum]);
        if (segnum < numSubs) {
          let c = '\u221e';
          if (segnum === 0) {
            c = '\u24ea';
          } else if (1 <= segnum && segnum <= 20) {
            c = String.fromCharCode(0x2460 + segnum - 1);
          }
          result.push(c);
        }
      }
      return result.join('');
    }
  }


  // Breaks a string into tokens for cheap ad hoc DSLs
  const TOKEN_RE = captureRE(anyRE(
    SPACE_RE,
    NUMBER_RE,
    STRING_RE,
    IDENT_RE,
    SINGLE_OP,
    MULTI_OP,
    LINE_COMMENT_RE
  ));


  /**
   * To call the packrat-memoized form of a rule N, call
   * this.run(this.rule_N, pos, 'N') rather than
   * this.rule_N(pos). Likewise, call this.run(super.rule_N, pos, 'N')
   * rather than super.rule_N(pos).
   */
  class Packratter {
    constructor() {
      // _memo and _counts should all be private instance
      // variables.
      this._memo = new Map();
      // This won't work when moving to SES because the "def(this)" in
      // the constructor will freeze _counts as it should. After
      // all, this is mutable state our clients can corrupt.
      this._counts = {hits: 0, misses: 0};
    }
    run(ruleOrPatt, pos, name) {
      if (this.constructor._debug) {
        console.log(`run(f, ${pos}, ${name})`);
      }
      let posm = this._memo.get(pos);
      if (!posm) {
        posm = new Map();
        this._memo.set(pos, posm);
      }
      let result = posm.get(ruleOrPatt);
      if (result) {
        if (result === LEFT_RECUR) {
          throw new Error(`Left recursion on rule: ${name}`);
        }
        this._counts.hits++;
      } else {
        posm.set(ruleOrPatt, LEFT_RECUR);
        this._counts.misses++;
        if (typeof ruleOrPatt === 'function') {
          result = ruleOrPatt.call(this, pos);
        } else if (ruleOrPatt === void 0) {
          throw new Error(`Rule missing: ${name}`);
        } else {
          result = this.eat(pos, ruleOrPatt);
        }
        posm.set(ruleOrPatt, result);
      }
      return result;
    }
    lastFailures() {
      let maxPos = 0;
      let fails = [];
      for (let [pos, posm] of this._memo) {
        for (let [ruleOrPatt, result] of posm) {
          if (typeof ruleOrPatt !== 'function' && result !== LEFT_RECUR) {
            const fail = JSON.stringify(''+ruleOrPatt);
            const [newPos, v] = result;
            if (v === FAIL) {
              if (newPos > maxPos) {
                maxPos = newPos;
                fails = [fail];
              } else if (newPos === maxPos) {
                fails.push(fail);
              }
            }
          }
        }
      }
      return [maxPos, fails];
    }
    done() {
      if (this.constructor._debug) {
        console.log('\n');
        for (let [pos, posm] of this._memo) {
          const fails = [];
          for (let [ruleOrPatt, result] of posm) {
            const name = typeof ruleOrPatt === 'function' ?
                           ruleOrPatt.name : JSON.stringify(ruleOrPatt);
            if (result === LEFT_RECUR) {
              console.log(`${name}(${pos}) => left recursion detector`);
            } else {
              const [newPos, v] = result;
              if (v === FAIL) {
                fails.push(name);
              } else {
                console.log(`${name}(${pos}) => [${newPos}, ${v}]`);
              }
            }
          }
          if (fails.length >= 1) {
            console.log(`@${pos} => FAIL [${fails}]`);
          }
        }
        console.log(`hits: ${this._counts.hits
                  }, misses: ${this._counts.misses}`);
      }
    }
  }

  // _debug should be a private static variable
  Packratter._debug = false;


  /**
   * The default base Parser class for parser traits to extend. This
   * provides a simple conventional lexer, where the production rules
   * correspond to conventional token types. Parsers defined using the
   * <tt>bootbnf.bnf</tt> tag that extend this one generally define
   * the second level of a two level grammar. It you wish to inherit
   * from Scanner in order to define a derived lexer, you probably
   * need to use EcmaScript class inheritance directly.
   */
  class Scanner extends Packratter {
    constructor(template, tokenTypeList=[]) {
      super();
      this.template = template;
      this.keywords = new Set();
      this.otherTokenTypes = new Set();
      tokenTypeList.forEach(tt => {
        if (allRE(IDENT_RE).test(tt)) {
          this.keywords.add(tt);
        } else {
          this.otherTokenTypes.add(tt);
        }
      });
      def(this.keywords);  // TODO: should also freeze set contents
      def(this.otherTokenTypes);  // TODO: should also freeze set contents

      // TODO: derive TOKEN_RE from otherTokenTypes
      this.toks = Token.tokensInTemplate(template.raw, TOKEN_RE);
      def(this);
    }
    start() {
      return this.toks.map(token => token.text);
    }
    syntaxError() {
      console.log(`
-------template--------
${JSON.stringify(this.template, void 0, ' ')}
-------`);
      const [last, fails] = this.lastFailures();
      const tokStr = last < this.toks.length ?
        `At ${this.toks[last]}` :
        `Unexpected EOF after ${this.toks[this.toks.length - 1]}`;
      const failStr = fails.length === 0 ? 
        `stuck` : `looking for ${fails.join(' ')}`;
      throw new SyntaxError(`${tokStr} ${failStr}`);
    }
    skip(pos, RE) {
      if (pos < this.toks.length) {
        const token = this.toks[pos];
        if (typeof token !== 'number') {
          if (allRE(RE).test(token.text)) {
            return [pos + 1, ''];
          }
        }
      }
      return [pos, FAIL];
    }
    rule_SPACE(pos) {
      return this.skip(pos, SPACE_RE);
    }
    rule_COMMENT(pos) {
      return this.skip(pos, LINE_COMMENT_RE);
    }

    // Must always succeed
    //   (SPACE / COMMENT)*
    // Callers should not memoize calls to rule_SKIP as it is likely
    // not worth it. rule_SKIP does not memoize its call to rule_SPACE
    // for the same reason. However, it does memoize its call to
    // rule_COMMENT.
    rule_SKIP(pos) {
      while (pos < this.toks.length) {
        const token = this.toks[pos];
        if (typeof token === 'number') { break; }
        let pair = this.rule_SPACE(pos);
        if (pair[1] !== FAIL) {
          pos = pair[0];
        } else {
          pair = this.run(this.rule_COMMENT, pos, 'COMMENT');
          if (pair[1] !== FAIL) {
            pos = pair[0];
          } else {
            break;
          }
        }
      }
      return [pos, ''];
    }

    eat(pos, patt) {
      [pos] = this.rule_SKIP(pos);
      if (pos < this.toks.length) {
        const token = this.toks[pos];
        if (typeof token !== 'number') {
          if ((typeof patt === 'string' && patt === token.text) ||
              allRE(patt).test(token.text)) {
            return [pos + 1, token.text];
          }
        }
      }
      return [pos, FAIL];
    }
    rule_NUMBER(pos) { return this.eat(pos, NUMBER_RE); }
    rule_STRING(pos) { return this.eat(pos, STRING_RE); }
    rule_IDENT(pos) {
      [pos] = this.rule_SKIP(pos);
      if (pos >= this.toks.length) { return [pos, FAIL]; }
      const token = this.toks[pos];
      if (typeof token === 'number') { return [pos, FAIL]; }
      if (allRE(IDENT_RE).test(token.text) &&
          !this.keywords.has(token.text)) {
        return [pos + 1, token.text];
      }
      return [pos, FAIL];
    }
    rule_HOLE(pos) {
      [pos] = this.rule_SKIP(pos);
      if (pos >= this.toks.length) { return [pos, FAIL]; }
      const token = this.toks[pos];
      if (typeof token === 'number') {
        return [pos + 1, token];
      }
      return [pos, FAIL];
    }
    rule_EOF(pos) {
      [pos] = this.rule_SKIP(pos);
      return [pos, pos >= this.toks.length ? EOF : FAIL];
    }
  }

  return def({
    FAIL, EOF,
    SPACE_RE, NUMBER_RE, STRING_RE, IDENT_RE,
    LINE_COMMENT_RE,
    allRE, anyRE, captureRE, stickyRE,
    Pos, Token, Packratter, Scanner
  });
}());
