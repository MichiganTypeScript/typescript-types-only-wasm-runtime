// Loaded by Monaco's TypeScript worker (setWorkerOptions customWorkerPath).
// Adds evalInputs(): asks the same checker that powers the editor's hints to
// resolve `type Inputs`, then reads the resulting tuple back as plain data.
// Nothing here parses the script text; if the checker can't compute the type,
// the run doesn't start.
self.customTSWorkerFactory = (TSWorker, tsArg) => class extends TSWorker {
  async evalInputs(fileName) {
    const ts = tsArg && tsArg.SyntaxKind ? tsArg : self.ts;
    const program = this._languageService.getProgram();
    const sf = program.getSourceFile(fileName);
    if (!sf) return { error: `no source file ${fileName}` };

    const errors = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) {
      // The innermost span is the useful one: a bad key also fails Run<>'s
      // constraint on the whole tuple, but the hold<> error points at the key.
      const d = errors.reduce((a, b) => ((b.length ?? 1e9) < (a.length ?? 1e9) ? b : a));
      const at = d.start != null ? `line ${sf.getLineAndCharacterOfPosition(d.start).line + 1}: ` : "";
      return { error: at + ts.flattenDiagnosticMessageText(d.messageText, "\n") };
    }

    const decl = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === "Inputs");
    if (!decl) return { error: "declare `type Inputs = [ ... ]`" };

    const checker = program.getTypeChecker();
    const isTuple = (t) => !!(t.flags & ts.TypeFlags.Object)
      && !!(t.objectFlags & ts.ObjectFlags.Reference)
      && !!(t.target.objectFlags & ts.ObjectFlags.Tuple);
    const show = (t) => checker.typeToString(t).slice(0, 120);
    const literal = (t) => {
      if (t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) return t.value;
      throw new Error(`expected a literal, got ${show(t)}`);
    };
    const keysOf = (t) => {
      if (t.flags & ts.TypeFlags.StringLiteral) return [t.value];
      if (isTuple(t)) return checker.getTypeArguments(t).map(literal);
      throw new Error(`expected Key[] , got ${show(t)}`);
    };
    const prop = (t, name) => {
      const sym = t.getProperty(name);
      return sym && checker.getTypeOfSymbolAtLocation(sym, decl);
    };

    // A Move type as [forward, side (+ right), turn (+ left), buttons], a ticcmd's fields.
    const MOVE = ["forward", "back", "strafeLeft", "strafeRight", "turnLeft", "turnRight", "fire", "use"];
    const STAGES = ["E1M1", "E1M2", "E1M3", "E1M4", "E1M5", "E1M6", "E1M7", "E1M8", "E1M9"];
    const WEAPONS = ["fist", "chainsaw", "pistol", "shotgun", "chaingun", "rocket"];
    const boolOf = (t, name) => {
      const s = show(t);
      if (s === "true") return true;
      if (s === "false") return false;
      throw new Error(`${name} must be true or false, got ${s}`);
    };
    const intOf = (t, name, min, max) => {
      const n = literal(t);
      if (!(Number.isInteger(n) && n >= min && n <= max)) {
        throw new Error(`${name} must be an integer ${min}..${max}, got ${show(t)}`);
      }
      return n;
    };
    const numTupleOf = (t, name, len, min, max) => {
      if (!isTuple(t)) throw new Error(`${name} must be a ${len}-number tuple, got ${show(t)}`);
      const args = checker.getTypeArguments(t);
      if (args.length !== len) throw new Error(`${name} must have ${len} numbers, got ${args.length}`);
      return args.map((a, k) => intOf(a, `${name}[${k}]`, min, max));
    };
    const moveOf = (t) => {
      const m = {};
      for (const sym of checker.getPropertiesOfType(t)) {
        const name = sym.getName();
        if (!MOVE.includes(name)) throw new Error(`"${name}" is not a Move field (${MOVE.join(", ")})`);
        const v = checker.getTypeOfSymbolAtLocation(sym, decl);
        if (name === "fire" || name === "use") {
          if (show(v) !== "true") throw new Error(`${name} must be true, got ${show(v)}`);
          m[name] = 1;
          continue;
        }
        const n = literal(v);
        const max = ["back", "strafeLeft", "turnRight"].includes(name) ? 128 : 127;
        if (!(Number.isInteger(n) && n >= 0 && n <= max)) throw new Error(`${name} must be 0 to ${max}, got ${n}`);
        m[name] = n;
      }
      for (const [x, y] of [["forward", "back"], ["strafeLeft", "strafeRight"], ["turnLeft", "turnRight"]])
        if (m[x] && m[y]) throw new Error(`a Move can't have both ${x} and ${y}`);
      return [
        (m.forward ?? 0) - (m.back ?? 0),
        (m.strafeRight ?? 0) - (m.strafeLeft ?? 0),
        (m.turnLeft ?? 0) - (m.turnRight ?? 0),
        (m.fire ?? 0) | ((m.use ?? 0) << 1),
      ];
    };
    const movesOf = (t) => {
      if (!isTuple(t)) throw new Error(`expected Move[], got ${show(t)}`);
      return checker.getTypeArguments(t).map((m, k) => {
        try { return moveOf(m); } catch (err) { throw new Error(`tic ${k}: ${err.message}`); }
      });
    };

    const inputs = checker.getTypeAtLocation(decl.name);
    if (!isTuple(inputs)) return { error: `Inputs must be a tuple, got ${show(inputs)}` };
    try {
      const steps = checker.getTypeArguments(inputs).map((e, i) => {
        try {
          if (isTuple(e)) return { keys: keysOf(e) };
          const keys = prop(e, "keys");
          const warp = prop(e, "warp");
          const skill = prop(e, "skill");
          const weapon = prop(e, "weapon");
          const health = prop(e, "health");
          const armor = prop(e, "armor");
          const armorType = prop(e, "armorType");
          const backpack = prop(e, "backpack");
          const god = prop(e, "god");
          const bossArena = prop(e, "bossArena");
          const owned = prop(e, "owned");
          const ammo = prop(e, "ammo");
          const rnd = prop(e, "rnd");
          const prnd = prop(e, "prnd");
          const playDemo = prop(e, "playDemo");
          const extendDemo = prop(e, "extendDemo");
          const setDemoTic = prop(e, "setDemoTic");
          const hasLoadout = !!(warp || weapon || health || armor || god || bossArena);
          if (!keys && !hasLoadout && !playDemo && !extendDemo && !setDemoTic)
            throw new Error(`expected Key[] or { keys, warp, weapon, health, armor, god, playDemo, extendDemo, setDemoTic }, got ${show(e)}`);
          if (!!playDemo + !!extendDemo + !!setDemoTic > 1) throw new Error("one of playDemo, extendDemo, setDemoTic per tic");
          let warpStage;
          if (warp) {
            warpStage = literal(warp);
            if (!STAGES.includes(warpStage)) throw new Error(`warp must be one of ${STAGES.join(", ")}, got ${show(warp)}`);
          }
          let weaponName;
          if (weapon) {
            weaponName = literal(weapon);
            if (!WEAPONS.includes(weaponName)) throw new Error(`weapon must be one of ${WEAPONS.join(", ")}, got ${show(weapon)}`);
          }
          const set = setDemoTic && checker.getTypeArguments(setDemoTic);
          return {
            keys: keys ? keysOf(keys) : [],
            warp: warpStage,
            skill: skill && intOf(skill, "skill", 1, 5),
            weapon: weaponName,
            health: health && intOf(health, "health", 1, 200),
            armor: armor && intOf(armor, "armor", 0, 200),
            armorType: armorType && intOf(armorType, "armorType", 0, 2),
            backpack: backpack && boolOf(backpack, "backpack"),
            god: god && boolOf(god, "god"),
            bossArena: bossArena && boolOf(bossArena, "bossArena"),
            owned: owned && numTupleOf(owned, "owned", 9, 0, 1),
            ammo: ammo && numTupleOf(ammo, "ammo", 4, 0, 600),
            rnd: rnd && intOf(rnd, "rnd", 0, 255),
            prnd: prnd && intOf(prnd, "prnd", 0, 255),
            playDemo: playDemo && movesOf(playDemo),
            extendDemo: extendDemo && movesOf(extendDemo),
            setDemoTic: set && [literal(set[0]), moveOf(set[1])],
          };
        } catch (err) {
          throw new Error(`Inputs[${i}]: ${err.message}`);
        }
      });
      return { steps };
    } catch (err) {
      return { error: err.message };
    }
  }
};
