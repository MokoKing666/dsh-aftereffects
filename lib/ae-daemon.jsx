/**
 * dsh-aftereffects — daemon bootstrap
 *
 * Written to a scratch directory and launched with
 *   AfterFX.exe -noui -r <this file>
 *
 * The daemon reads one JSON job file at a time from `jobs/`, evaluates it
 * against the runtime in `ae-runtime.jsx`, and writes `results/<id>.json`.
 * It heartbeats so the Host can tell a live AE from a dead one, and it exits
 * on `stop.flag` or when its own lifetime budget runs out.
 *
 * Everything here is ES3-compatible ExtendScript.
 */

(function () {
  var CONFIG = __DSH_CONFIG__;

  var ROOT = CONFIG.root;
  var RUNTIME = CONFIG.runtime;
  var LIFETIME_MS = CONFIG.lifetimeMs || 1800000;

  var jobsDir = new Folder(ROOT + '/jobs');
  if (!jobsDir.exists) jobsDir.create();
  var resDir = new Folder(ROOT + '/results');
  if (!resDir.exists) resDir.create();

  var heartbeatFile = ROOT + '/heartbeat';
  var stopFile = ROOT + '/stop.flag';
  var logFile = ROOT + '/daemon.log';

  function log(msg) {
    try {
      var f = new File(logFile);
      f.encoding = 'UTF-8';
      f.open('a');
      f.writeln((new Date()).getTime() + ' ' + msg);
      f.close();
    } catch (e) {}
  }

  function writeText(path, text) {
    var f = new File(path);
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(text);
    f.close();
  }

  function readText(path) {
    var f = new File(path);
    if (!f.exists) return null;
    f.encoding = 'UTF-8';
    if (!f.open('r')) return null;
    var s = f.read();
    f.close();
    return s;
  }

  function serialise(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(v);
    if (v instanceof Array) {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(serialise(v[i]));
      return '[' + parts.join(',') + ']';
    }
    var props = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      props.push(JSON.stringify(String(k)) + ':' + serialise(v[k]));
    }
    return '{' + props.join(',') + '}';
  }

  // --- runtime ------------------------------------------------------------
  var runtimeSource = readText(RUNTIME);
  if (runtimeSource === null) {
    writeText(ROOT + '/fatal.txt', 'runtime missing: ' + RUNTIME);
    return;
  }

  var DSH = null;
  try {
    DSH = eval(runtimeSource);
  } catch (e) {
    writeText(ROOT + '/fatal.txt', 'runtime load failed: ' + e + ' @' + (e.line || '?'));
    log('runtime load failed: ' + e);
    return;
  }

  log('daemon up: ae=' + app.version + ' runtime=' + DSH.version);

  var startedAt = new Date().getTime();
  var handled = 0;
  var running = true;

  // --- main loop ----------------------------------------------------------
  while (running) {
    var now = new Date().getTime();

    if (now - startedAt > LIFETIME_MS) { log('lifetime reached'); break; }

    writeText(heartbeatFile, String(now));

    if (new File(stopFile).exists) { log('stop flag'); break; }

    var files = jobsDir.getFiles('*.job');
    if (files.length === 0) {
      $.sleep(180);
      continue;
    }

    // oldest first
    var jobFile = files[0];
    for (var i = 1; i < files.length; i++) {
      if (files[i].name < jobFile.name) jobFile = files[i];
    }

    var body = readText(jobFile.fsName);
    var id = String(jobFile.name).replace(/\.job$/, '');
    var result;

    if (body === null) {
      result = '{"ok":false,"error":"job file unreadable"}';
    } else {
      try {
        var job = JSON.parse(body);
        var value;
        if (job.runtime) {
          // run a named runtime entry: { runtime: 'buildScene', payload: {...} }
          var fn = DSH[String(job.runtime)];
          if (typeof fn !== 'function') throw new Error('unknown runtime entry: ' + job.runtime);
          value = fn(job.payload);
        } else if (job.code) {
          value = eval('(function(payload, DSH){\n' + job.code + '\n})')(job.payload, DSH);
        } else {
          value = null;
        }
        result = '{"ok":true,"value":' + serialise(value) + '}';
      } catch (e) {
        result = '{"ok":false,"error":' + JSON.stringify(String(e && e.message ? e.message : e)) +
          ',"line":' + ((e && e.line) || -1) + '}';
      }
    }

    writeText(resDir.fsName + '/' + id + '.json', result);
    try { jobFile.remove(); } catch (e2) {}
    handled++;
    log('job ' + id + ' done (' + handled + ')');
  }

  // --- shutdown -----------------------------------------------------------
  try {
    var hb = new File(heartbeatFile);
    if (hb.exists) hb.remove();
  } catch (e3) {}

  log('daemon exit: jobs=' + handled);
})();
