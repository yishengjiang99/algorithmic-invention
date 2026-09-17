/**
 * Freestanding C subset → WebAssembly text.
 * Enough for the wavetable oscillator: statics, arrays, for/while/if,
 * float/int math, casts, exports. No malloc, no libc.
 */
(function (root, factory) {
  const api = factory();
  root.compileCToWat = api.compileCToWat;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TYPES = new Set(["void", "int", "unsigned", "float", "const", "static"]);

  function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }

  function preprocess(src) {
    const macros = [];
    const lines = stripComments(src).split(/\n/);
    const out = [];
    for (const line of lines) {
      const m = line.match(/^\s*#define\s+([A-Za-z_]\w*)\s+(.*)$/);
      if (m) {
        macros.push([m[1], m[2].trim()]);
        continue;
      }
      if (/^\s*#/.test(line)) continue;
      out.push(line);
    }
    macros.sort((a, b) => b[0].length - a[0].length);
    let text = out.join("\n");
    for (const [name, value] of macros) {
      text = text.replace(new RegExp("\\b" + name + "\\b", "g"), value);
    }
    return text;
  }

  function tokenize(src) {
    const re =
      /\s+|(__attribute__)|([A-Za-z_]\w*)|(\d+\.\d+([eE][+-]?\d+)?f?|\d+[eE][+-]?\d+f?|\d+f?)|("(?:\\.|[^"])*")|(<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|&=|\|=)|([()\[\]{};,?:]|[+\-*/%<>=!&|^~])/g;
    const tokens = [];
    let m;
    while ((m = re.exec(src))) {
      if (m[0].trim() === "") continue;
      if (m[1]) tokens.push({ k: "kw", v: m[1] });
      else if (m[2]) tokens.push({ k: TYPES.has(m[2]) || m[2] === "return" || m[2] === "if" || m[2] === "else" || m[2] === "for" || m[2] === "while" || m[2] === "continue" || m[2] === "void" ? "kw" : "id", v: m[2] });
      else if (m[3]) tokens.push({ k: "num", v: m[3] });
      else if (m[5]) tokens.push({ k: "str", v: JSON.parse(m[5]) });
      else if (m[6]) tokens.push({ k: "op", v: m[6] });
      else if (m[7]) tokens.push({ k: "op", v: m[7] });
    }
    tokens.push({ k: "eof", v: "" });
    return tokens;
  }

  function compileCToWat(source) {
    const log = [];
    const text = preprocess(source);
    const tok = tokenize(text);
    let i = 0;
    const peek = () => tok[i];
    const at = (v) => peek().v === v;
    const eat = (v) => {
      if (v && peek().v !== v) fail("expected " + v + " got " + peek().v);
      return tok[i++];
    };
    const fail = (msg) => {
      throw new Error("c2wat: " + msg + " at '" + peek().v + "'");
    };

    const isType = (t) => t && (t.v === "void" || t.v === "int" || t.v === "unsigned" || t.v === "float" || t.v === "const" || t.v === "static");

    function parseType() {
      let storage = null;
      while (peek().v === "static" || peek().v === "const") {
        if (peek().v === "static") storage = "static";
        eat();
      }
      let base = "i32";
      if (peek().v === "float") {
        base = "f32";
        eat();
      } else if (peek().v === "void") {
        base = "void";
        eat();
      } else if (peek().v === "int" || peek().v === "unsigned") {
        base = "i32";
        eat();
      } else fail("type");
      let ptr = false;
      if (at("*")) {
        eat("*");
        ptr = true;
        base = "i32";
      }
      return { base: ptr ? "i32" : base, ptr, storage };
    }

    const globals = Object.create(null);
    let mem = 16;
    function align4(n) {
      return (n + 3) & ~3;
    }
    function alloc(bytes) {
      const a = align4(mem);
      mem = a + bytes;
      return a;
    }

    const funcs = [];
    const funcMap = Object.create(null);

    function parseExportAttr() {
      if (peek().v !== "__attribute__") return null;
      eat();
      eat("(");
      eat("(");
      if (peek().v !== "export_name") fail("export_name");
      eat();
      eat("(");
      const name = eat().v;
      eat(")");
      eat(")");
      eat(")");
      return name;
    }

    function parseFile() {
      while (peek().k !== "eof") {
        const exp = parseExportAttr();
        const ty = parseType();
        const name = eat().v;
        if (at("(")) {
          eat("(");
          const params = [];
          if (!at(")") && peek().v !== "void") {
            while (true) {
              const pt = parseType();
              let pn = "p" + params.length;
              if (peek().k === "id") pn = eat().v;
              params.push({ name: pn, ty: pt.base });
              if (!at(",")) break;
              eat(",");
            }
          } else if (peek().v === "void") eat();
          eat(")");
          const body = parseBlock();
          const fn = { name, ty: ty.base, params, body, exp: exp || (ty.storage ? null : name) };
          funcs.push(fn);
          funcMap[name] = fn;
        } else {
          const dims = [];
          while (at("[")) {
            eat("[");
            dims.push(numValue(parseExpr()));
            eat("]");
          }
          let init = null;
          if (at("=")) {
            eat("=");
            init = parseExpr();
          }
          eat(";");
          let count = 1;
          for (const d of dims) count *= d;
          const bytes = (ty.base === "f32" ? 4 : 4) * count;
          const addr = alloc(bytes);
          globals[name] = { name, ty: ty.base, dims, addr, count, init };
        }
      }
    }

    function parseBlock() {
      eat("{");
      const stmts = [];
      while (!at("}")) stmts.push(parseStmt());
      eat("}");
      return { k: "block", stmts };
    }

    function parseStmt() {
      if (at("{")) return parseBlock();
      if (peek().v === "if") {
        eat();
        eat("(");
        const c = parseExpr();
        eat(")");
        const a = parseStmt();
        let b = null;
        if (peek().v === "else") {
          eat();
          b = parseStmt();
        }
        return { k: "if", c, a, b };
      }
      if (peek().v === "while") {
        eat();
        eat("(");
        const c = parseExpr();
        eat(")");
        const body = parseStmt();
        return { k: "while", c, body };
      }
      if (peek().v === "for") {
        eat();
        eat("(");
        let init = null;
        if (!at(";")) {
          if (isType(peek())) init = parseDeclStmt();
          else {
            init = { k: "expr", e: parseExpr() };
            eat(";");
          }
        } else eat(";");
        let cond = null;
        if (!at(";")) cond = parseExpr();
        eat(";");
        let inc = null;
        if (!at(")")) inc = parseExpr();
        eat(")");
        const body = parseStmt();
        return { k: "for", init, cond, inc, body };
      }
      if (peek().v === "return") {
        eat();
        const e = at(";") ? null : parseExpr();
        eat(";");
        return { k: "return", e };
      }
      if (peek().v === "continue") {
        eat();
        eat(";");
        return { k: "continue" };
      }
      if (isType(peek())) return parseDeclStmt();
      if (at(";")) {
        eat(";");
        return { k: "nop" };
      }
      const e = parseExpr();
      eat(";");
      return { k: "expr", e };
    }

    function parseDeclStmt() {
      const ty = parseType();
      const name = eat().v;
      let init = null;
      if (at("=")) {
        eat("=");
        init = parseExpr();
      }
      eat(";");
      return { k: "decl", ty: ty.base, name, init };
    }

    function parseExpr() {
      return parseAssign();
    }

    function parseAssign() {
      const left = parseTernary();
      if (["=", "+=", "-=", "*=", "/=", "&=", "|="].includes(peek().v)) {
        const op = eat().v;
        const right = parseAssign();
        return { k: "assign", op, left, right };
      }
      return left;
    }

    function parseTernary() {
      const c = parseOr();
      if (at("?")) {
        eat("?");
        const a = parseExpr();
        eat(":");
        const b = parseTernary();
        return { k: "tern", c, a, b };
      }
      return c;
    }

    function binLeft(next, ops) {
      return function () {
        let left = next();
        while (ops.includes(peek().v)) {
          const op = eat().v;
          const right = next();
          left = { k: "bin", op, left, right };
        }
        return left;
      };
    }

    const parseMul = binLeft(parseUnary, ["*", "/", "%"]);
    const parseAdd = binLeft(parseMul, ["+", "-"]);
    const parseShift = binLeft(parseAdd, ["<<", ">>"]);
    const parseRel = binLeft(parseShift, ["<", ">", "<=", ">="]);
    const parseEq = binLeft(parseRel, ["==", "!="]);
    const parseBitAnd = binLeft(parseEq, ["&"]);
    const parseBitXor = binLeft(parseBitAnd, ["^"]);
    const parseBitOr = binLeft(parseBitXor, ["|"]);
    const parseAnd = binLeft(parseBitOr, ["&&"]);
    const parseOr = binLeft(parseAnd, ["||"]);

    function parseUnary() {
      if (at("++") || at("--")) {
        const op = eat().v;
        return { k: "pre", op, e: parseUnary() };
      }
      if (at("+") || at("-") || at("!") || at("~")) {
        const op = eat().v;
        return { k: "un", op, e: parseUnary() };
      }
      if (at("(")) {
        const save = i;
        eat("(");
        if (isType(peek()) && peek().v !== "const" && peek().v !== "static") {
          const ty = parseType();
          if (at(")")) {
            eat(")");
            return { k: "cast", ty: ty.base, e: parseUnary() };
          }
        }
        i = save;
      }
      return parsePost();
    }

    function parsePost() {
      let e = parsePrim();
      for (;;) {
        if (at("[")) {
          eat("[");
          const idx = parseExpr();
          eat("]");
          e = { k: "index", e, idx };
        } else if (at("(")) {
          eat("(");
          const args = [];
          if (!at(")")) {
            while (true) {
              args.push(parseExpr());
              if (!at(",")) break;
              eat(",");
            }
          }
          eat(")");
          e = { k: "call", e, args };
        } else if (at("++") || at("--")) {
          e = { k: "post", op: eat().v, e };
        } else break;
      }
      return e;
    }

    function parsePrim() {
      if (at("(")) {
        eat("(");
        const e = parseExpr();
        eat(")");
        return e;
      }
      if (peek().k === "num") {
        const v = eat().v;
        const isF = /[.\eEfF]/.test(v);
        return { k: "num", v, ty: isF ? "f32" : "i32" };
      }
      if (peek().k === "id") return { k: "id", v: eat().v };
      fail("expr");
    }

    function numValue(e) {
      if (e.k === "num") return parseFloat(e.v);
      if (e.k === "un" && e.op === "-" && e.e.k === "num") return -parseFloat(e.e.v);
      if (e.k === "bin" && e.op === "-") return numValue(e.left) - numValue(e.right);
      if (e.k === "bin" && e.op === "+") return numValue(e.left) + numValue(e.right);
      if (e.k === "bin" && e.op === "*") return numValue(e.left) * numValue(e.right);
      if (e.k === "bin" && e.op === "/") return numValue(e.left) / numValue(e.right);
      throw new Error("c2wat: const dim");
    }

    parseFile();
    if (mem > 65536) throw new Error("c2wat: statics exceed 64KiB (" + mem + ")");

    let uid = 0;
    const watFns = [];

    function emitFn(fn) {
      const locals = Object.create(null);
      const localList = [];
      function addLocal(name, ty) {
        if (locals[name]) return locals[name];
        const id = name.replace(/[^A-Za-z0-9_]/g, "_") + "_" + uid++;
        locals[name] = { id, ty };
        localList.push({ id, ty });
        return locals[name];
      }
      fn.params.forEach((p) => addLocal(p.name, p.ty));
      let contLabel = null;
      const lines = [];

      function conv(e, ty) {
        const v = gen(e);
        if (v.ty === ty) return v;
        if (v.ty === "i32" && ty === "f32") {
          v.code.push("f32.convert_i32_s");
          v.ty = "f32";
        } else if (v.ty === "f32" && ty === "i32") {
          v.code.push("i32.trunc_f32_s");
          v.ty = "i32";
        } else if (ty === "void") {
          v.code.push("drop");
          v.ty = "void";
        }
        return v;
      }

      function addrOf(e) {
        if (e.k === "id") {
          const g = globals[e.v];
          if (g) return { code: ["i32.const " + g.addr], ty: "i32", g };
          fail("addr " + e.v);
        }
        if (e.k === "index") {
          let base = e.e;
          const idxs = [e.idx];
          while (base.k === "index") {
            idxs.unshift(base.idx);
            base = base.e;
          }
          if (base.k !== "id" || !globals[base.v]) fail("index base");
          const g = globals[base.v];
          const dims = g.dims;
          const code = ["i32.const 0"];
          for (let n = 0; n < idxs.length; n++) {
            let after = 1;
            for (let k = n + 1; k < dims.length; k++) after *= dims[k];
            const ix = conv(idxs[n], "i32");
            code.push(...ix.code);
            if (after !== 1) code.push("i32.const " + after, "i32.mul");
            code.push("i32.add");
          }
          code.push("i32.const 4", "i32.mul", "i32.const " + g.addr, "i32.add");
          return { code, ty: "i32", g };
        }
        fail("lvalue");
      }

      function loadSym(name) {
        if (locals[name]) {
          return { code: ["local.get $" + locals[name].id], ty: locals[name].ty };
        }
        const g = globals[name];
        if (g) {
          if (g.dims.length) return { code: ["i32.const " + g.addr], ty: "i32", decay: g };
          const op = g.ty === "f32" ? "f32.load" : "i32.load";
          return { code: ["i32.const " + g.addr, op], ty: g.ty };
        }
        if (funcMap[name]) return { code: [], ty: "fn", fn: funcMap[name] };
        fail("unknown " + name);
      }

      function gen(e) {
        if (!e) return { code: [], ty: "void" };
        switch (e.k) {
          case "num": {
            if (e.ty === "f32") return { code: ["f32.const " + parseFloat(e.v)], ty: "f32" };
            return { code: ["i32.const " + (parseInt(e.v, 10) | 0)], ty: "i32" };
          }
          case "id":
            return loadSym(e.v);
          case "un": {
            if (e.op === "-") {
              const v = gen(e.e);
              if (v.ty === "f32") {
                v.code.push("f32.neg");
                return v;
              }
              v.code.push("i32.const -1", "i32.mul");
              return v;
            }
            if (e.op === "+") return gen(e.e);
            if (e.op === "!") {
              const v = conv(e.e, "i32");
              v.code.push("i32.eqz");
              return v;
            }
            if (e.op === "~") {
              const v = conv(e.e, "i32");
              v.code.push("i32.const -1", "i32.xor");
              return v;
            }
            fail("un " + e.op);
          }
          case "cast": {
            const v = gen(e.e);
            if (v.ty === e.ty) return v;
            if (v.ty === "i32" && e.ty === "f32") {
              v.code.push("f32.convert_i32_s");
              v.ty = "f32";
            } else if (v.ty === "f32" && e.ty === "i32") {
              v.code.push("i32.trunc_f32_s");
              v.ty = "i32";
            }
            return v;
          }
          case "bin":
            return genBin(e);
          case "tern": {
            const c = conv(e.c, "i32");
            const a = gen(e.a);
            const b = conv(e.b, a.ty);
            const ty = a.ty;
            return {
              code: [
                ...c.code,
                "if (result " + ty + ")",
                ...a.code,
                "else",
                ...b.code,
                "end",
              ],
              ty,
            };
          }
          case "index": {
            const a = addrOf(e);
            const op = a.g.ty === "f32" ? "f32.load" : "i32.load";
            return { code: [...a.code, op], ty: a.g.ty };
          }
          case "call": {
            if (e.e.k !== "id") fail("call");
            const fn = funcMap[e.e.v];
            if (!fn) fail("call " + e.e.v);
            const code = [];
            fn.params.forEach((p, n) => {
              const a = conv(e.args[n] || { k: "num", v: "0", ty: p.ty }, p.ty);
              code.push(...a.code);
            });
            code.push("call $" + fn.name);
            return { code, ty: fn.ty };
          }
          case "assign":
            return genAssign(e);
          case "pre":
          case "post":
            return genInc(e);
          case "raw":
            return e;
          default:
            fail("gen " + e.k);
        }
      }

      function genBin(e) {
        const op = e.op;
        if (op === "&&" || op === "||") {
          const a = conv(e.left, "i32");
          const b = conv(e.right, "i32");
          a.code.push("i32.const 0", "i32.ne");
          b.code.push("i32.const 0", "i32.ne");
          return { code: [...a.code, ...b.code, op === "&&" ? "i32.and" : "i32.or"], ty: "i32" };
        }
        let l = gen(e.left);
        let r = gen(e.right);
        let ty = l.ty;
        if (l.ty !== r.ty) {
          if (l.ty === "i32") {
            l.code.push("f32.convert_i32_s");
            l.ty = "f32";
            ty = "f32";
          }
          if (r.ty === "i32") {
            r.code.push("f32.convert_i32_s");
            r.ty = "f32";
            ty = "f32";
          }
        }
        const f = ty === "f32";
        const map = {
          "+": f ? "f32.add" : "i32.add",
          "-": f ? "f32.sub" : "i32.sub",
          "*": f ? "f32.mul" : "i32.mul",
          "/": f ? "f32.div" : "i32.div_s",
          "%": "i32.rem_s",
          "&": "i32.and",
          "|": "i32.or",
          "^": "i32.xor",
          "<<": "i32.shl",
          ">>": "i32.shr_s",
          "<": f ? "f32.lt" : "i32.lt_s",
          ">": f ? "f32.gt" : "i32.gt_s",
          "<=": f ? "f32.le" : "i32.le_s",
          ">=": f ? "f32.ge" : "i32.ge_s",
          "==": f ? "f32.eq" : "i32.eq",
          "!=": f ? "f32.ne" : "i32.ne",
        };
        const ins = map[op];
        if (!ins) fail("bin " + op);
        const outTy = ["<", ">", "<=", ">=", "==", "!="].includes(op) ? "i32" : ty;
        return { code: [...l.code, ...r.code, ins], ty: outTy };
      }

      function storeAt(addrCode, ty, val) {
        const op = ty === "f32" ? "f32.store" : "i32.store";
        return [...addrCode, ...val.code, op];
      }

      function genAssign(e) {
        const rhs = e.op === "=" ? gen(e.right) : genBin({ k: "bin", op: e.op[0], left: e.left, right: e.right });
        if (e.left.k === "id" && locals[e.left.v]) {
          const loc = locals[e.left.v];
          const v = rhs.ty === loc.ty ? rhs : conv(e.op === "=" ? e.right : { k: "raw", code: rhs.code, ty: rhs.ty }, loc.ty);
          // conv of raw is messy — coerce here
          const code = rhs.code.slice();
          if (rhs.ty !== loc.ty) {
            if (rhs.ty === "i32" && loc.ty === "f32") code.push("f32.convert_i32_s");
            if (rhs.ty === "f32" && loc.ty === "i32") code.push("i32.trunc_f32_s");
          }
          code.push("local.tee $" + loc.id);
          return { code, ty: loc.ty };
        }
        if (e.left.k === "id" && globals[e.left.v] && !globals[e.left.v].dims.length) {
          const g = globals[e.left.v];
          const code = rhs.code.slice();
          if (rhs.ty !== g.ty) {
            if (rhs.ty === "i32" && g.ty === "f32") code.push("f32.convert_i32_s");
            if (rhs.ty === "f32" && g.ty === "i32") code.push("i32.trunc_f32_s");
          }
          const tmp = addLocal("__t" + uid, g.ty);
          return {
            code: [
              ...code,
              "local.set $" + tmp.id,
              "i32.const " + g.addr,
              "local.get $" + tmp.id,
              g.ty === "f32" ? "f32.store" : "i32.store",
              "local.get $" + tmp.id,
            ],
            ty: g.ty,
          };
        }
        const a = addrOf(e.left);
        const tmp = addLocal("__s" + uid, a.g.ty);
        const code = rhs.code.slice();
        if (rhs.ty !== a.g.ty) {
          if (rhs.ty === "i32" && a.g.ty === "f32") code.push("f32.convert_i32_s");
          if (rhs.ty === "f32" && a.g.ty === "i32") code.push("i32.trunc_f32_s");
        }
        return {
          code: [
            ...code,
            "local.set $" + tmp.id,
            ...a.code,
            "local.get $" + tmp.id,
            a.g.ty === "f32" ? "f32.store" : "i32.store",
            "local.get $" + tmp.id,
          ],
          ty: a.g.ty,
        };
      }

      function genInc(e) {
        const one = { k: "num", v: "1", ty: "i32" };
        const op = e.op === "++" ? "+" : "-";
        if (e.k === "pre") return genAssign({ k: "assign", op: op + "=", left: e.e, right: one });
        const cur = gen(e.e);
        const as = genAssign({ k: "assign", op: op + "=", left: e.e, right: one });
        // value is old; we already stored new. Recompute old = new - 1
        const ty = cur.ty;
        if (ty === "f32") {
          as.code.push("f32.const 1", e.op === "++" ? "f32.sub" : "f32.add");
        } else {
          as.code.push("i32.const 1", e.op === "++" ? "i32.sub" : "i32.add");
        }
        return { code: as.code, ty };
      }

      function emitStmt(s) {
        if (!s || s.k === "nop") return;
        if (s.k === "block") {
          s.stmts.forEach(emitStmt);
          return;
        }
        if (s.k === "decl") {
          const loc = addLocal(s.name, s.ty);
          if (s.init) {
            const v = gen(s.init);
            const code = v.code.slice();
            if (v.ty !== s.ty) {
              if (v.ty === "i32" && s.ty === "f32") code.push("f32.convert_i32_s");
              if (v.ty === "f32" && s.ty === "i32") code.push("i32.trunc_f32_s");
            }
            lines.push(...code, "local.set $" + loc.id);
          }
          return;
        }
        if (s.k === "expr") {
          const v = gen(s.e);
          if (v.ty !== "void" && v.code.length) {
            lines.push(...v.code, "drop");
          } else lines.push(...v.code);
          return;
        }
        if (s.k === "return") {
          if (s.e) {
            const v = gen(s.e);
            const code = v.code.slice();
            if (fn.ty !== "void" && v.ty !== fn.ty) {
              if (v.ty === "i32" && fn.ty === "f32") code.push("f32.convert_i32_s");
              if (v.ty === "f32" && fn.ty === "i32") code.push("i32.trunc_f32_s");
            }
            // array decay already i32
            lines.push(...code, "return");
          } else lines.push("return");
          return;
        }
        if (s.k === "continue") {
          if (!contLabel) fail("continue");
          lines.push("br $" + contLabel);
          return;
        }
        if (s.k === "if") {
          const c = conv(s.c, "i32");
          lines.push(...c.code, "if");
          emitStmt(s.a);
          if (s.b) {
            lines.push("else");
            emitStmt(s.b);
          }
          lines.push("end");
          return;
        }
        if (s.k === "while") {
          const prev = contLabel;
          const L = "w" + uid++;
          contLabel = L + "c";
          lines.push("block $" + L + "e", "loop $" + L);
          const c = conv(s.c, "i32");
          lines.push(...c.code, "i32.eqz", "br_if $" + L + "e");
          lines.push("block $" + contLabel);
          emitStmt(s.body);
          lines.push("end", "br $" + L, "end", "end");
          contLabel = prev;
          return;
        }
        if (s.k === "for") {
          const prev = contLabel;
          const L = "f" + uid++;
          contLabel = L + "c";
          if (s.init) emitStmt(s.init);
          lines.push("block $" + L + "e", "loop $" + L);
          if (s.cond) {
            const c = conv(s.cond, "i32");
            lines.push(...c.code, "i32.eqz", "br_if $" + L + "e");
          }
          lines.push("block $" + contLabel);
          emitStmt(s.body);
          lines.push("end");
          if (s.inc) {
            const v = gen(s.inc);
            if (v.ty !== "void") lines.push(...v.code, "drop");
            else lines.push(...v.code);
          }
          lines.push("br $" + L, "end", "end");
          contLabel = prev;
          return;
        }
        fail("stmt " + s.k);
      }

      // rebind gen after genCast - the double gen is messy. Flatten:
      // I'll leave the inner override.

      emitStmt(fn.body);
      if (fn.ty !== "void") lines.push("unreachable");

      const locDecl = localList
        .filter((l) => !fn.params.some((p) => locals[p.name] && locals[p.name].id === l.id))
        .map((l) => "    (local $" + l.id + " " + l.ty + ")")
        .join("\n");
      const params = fn.params.map((p) => "(param $" + locals[p.name].id + " " + p.ty + ")").join(" ");
      const result = fn.ty === "void" ? "" : "(result " + fn.ty + ")";
      const exp = fn.exp ? " (export \"" + fn.exp + "\")" : "";
      watFns.push(
        "  (func $" +
          fn.name +
          exp +
          " " +
          params +
          " " +
          result +
          "\n" +
          (locDecl ? locDecl + "\n" : "") +
          lines.map((x) => "    " + x).join("\n") +
          "\n  )"
      );
    }

    // emitFn holds a single gen().

    funcs.forEach(emitFn);

    const inits = [];
    for (const g of Object.values(globals)) {
      if (g.init && g.init.k === "num") {
        const v = parseFloat(g.init.v);
        if (g.ty === "f32") inits.push("    i32.const " + g.addr, "    f32.const " + v, "    f32.store");
        else inits.push("    i32.const " + g.addr, "    i32.const " + (v | 0), "    i32.store");
      }
    }

    const wat = [
      "(module",
      "  (memory (export \"memory\") 1 1)",
      inits.length
        ? "  (func $__init_statics\n" + inits.join("\n") + "\n  )\n  (start $__init_statics)"
        : "",
      watFns.join("\n"),
      ")",
    ]
      .filter(Boolean)
      .join("\n");

    log.push("statics " + mem + " bytes");
    log.push("funcs " + funcs.length);
    return { wat, log, mem };
  }

  return { compileCToWat };
});
