// The OBS overlay for Plum's chat polls, served at GET /overlay/poll and added to OBS as a
// Browser Source. It reads GET /overlay/poll/state (ChatPollService.overlay) twice a second:
// it slides in when a poll opens, counts down, shows each numbered option's votes, then holds
// the result and slides away. Query: ?scale=1.3 (size), ?hold=12 (seconds the result stays),
// ?demo (a looping fake poll; also when the file is opened straight from disk).
//
// The page's own script uses no backticks, no dollar-brace and no backslashes, so this
// template literal holds it verbatim.

export const POLL_OVERLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plum Chat Vote</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --card: rgba(22, 12, 38, 0.92);
    --edge: rgba(184, 115, 255, 0.55);
    --plum: #b873ff;
    --plum-deep: #7a3fd0;
    --ink: #1a0d2e;
    --text: #fbf7ff;
    --muted: #cbb8e6;
    --track: rgba(255, 255, 255, 0.1);
    --win: #62e36f;
    --warn: #ffc24b;
    --hot: #ff5d73;
  }

  html, body { margin: 0; background: transparent; overflow: hidden; }

  body {
    padding: 16px;
    font-family: Nunito, 'Segoe UI', system-ui, sans-serif;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }

  .card {
    box-sizing: border-box;
    width: 100%;
    max-width: 560px;
    padding: 18px 20px 16px;
    background: var(--card);
    border: 2px solid var(--edge);
    border-radius: 20px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    transition: opacity 0.45s ease, transform 0.55s cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .card.hidden { opacity: 0; transform: translateY(-24px) scale(0.96); }

  .head { display: flex; align-items: center; gap: 10px; }

  .badge {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--plum);
  }

  .plumbob { width: 18px; height: 27px; filter: drop-shadow(0 0 6px rgba(98, 227, 111, 0.65)); animation: bob 3s ease-in-out infinite; }

  .timer {
    margin-left: auto;
    min-width: 66px;
    padding: 4px 12px;
    border: 1.5px solid var(--edge);
    border-radius: 999px;
    background: rgba(184, 115, 255, 0.18);
    font-size: 22px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .timer.warn { color: var(--warn); border-color: var(--warn); background: rgba(255, 194, 75, 0.15); }
  .timer.hot { color: var(--hot); border-color: var(--hot); background: rgba(255, 93, 115, 0.18); animation: pulse 1s ease-in-out infinite; }
  .timer.final { color: var(--win); border-color: var(--win); background: rgba(98, 227, 111, 0.14); }

  .question { margin: 12px 0 10px; font-size: 26px; font-weight: 900; line-height: 1.2; text-wrap: balance; }

  .clock { height: 6px; margin-bottom: 14px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .clock > i { display: block; height: 100%; background: linear-gradient(90deg, var(--plum-deep), var(--plum)); transform-origin: left; }
  .card.done .clock { visibility: hidden; }

  .options { display: flex; flex-direction: column; gap: 10px; }

  .opt {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    align-items: center;
    gap: 6px 12px;
    padding: 10px 12px;
    border: 1.5px solid transparent;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.05);
    transition: border-color 0.3s, background 0.3s, opacity 0.4s;
  }

  .num {
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--plum);
    color: var(--ink);
    font-size: 22px;
    font-weight: 900;
  }

  .title { font-size: 20px; font-weight: 800; line-height: 1.2; overflow-wrap: anywhere; }

  .count { font-size: 20px; font-weight: 900; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .count small { margin-left: 6px; font-size: 14px; font-weight: 800; color: var(--muted); }

  .bar { grid-column: 2 / 4; height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; }
  .bar > i { display: block; width: 0; height: 100%; border-radius: 5px; background: var(--plum); transition: width 0.6s cubic-bezier(0.2, 0.9, 0.3, 1); }

  .opt.lead { border-color: var(--edge); background: rgba(184, 115, 255, 0.12); }
  .opt.bump .count { animation: pop 0.4s ease; }

  .card.done .opt { opacity: 0.45; }
  .card.done .opt.win { opacity: 1; border-color: var(--win); background: rgba(98, 227, 111, 0.14); }
  .card.done .opt.win .num, .card.done .opt.win .bar > i { background: var(--win); }

  .foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 14px; font-size: 15px; font-weight: 800; color: var(--muted); }
  .foot b { color: var(--text); }
  .card.done .foot b { color: var(--win); }

  @keyframes bob { 50% { transform: translateY(-3px); } }
  @keyframes pulse { 50% { transform: scale(1.08); } }
  @keyframes pop { 40% { transform: scale(1.3); } }
</style>
</head>
<body>
<div class="card hidden" id="card">
  <div class="head">
    <div class="badge">
      <svg class="plumbob" viewBox="0 0 20 30" aria-hidden="true">
        <polygon points="10,0 19,12 10,30 1,12" fill="#62e36f"/>
        <polygon points="10,0 19,12 10,14" fill="#a6f7ad"/>
        <polygon points="10,0 1,12 10,14" fill="#82ec8c"/>
        <polygon points="1,12 10,14 10,30" fill="#3fbf4d"/>
        <polygon points="19,12 10,14 10,30" fill="#2c9a38"/>
      </svg>
      <span id="badge">Chat vote</span>
    </div>
    <div class="timer" id="timer">0:00</div>
  </div>
  <div class="question" id="question"></div>
  <div class="clock"><i id="clock"></i></div>
  <div class="options" id="options"></div>
  <div class="foot"><span id="footLeft"></span><span id="footRight"></span></div>
</div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var holdMs = (Number(params.get('hold')) || 12) * 1000;
  var scale = Number(params.get('scale'));
  var demo = params.has('demo') || location.protocol === 'file:';
  if (scale > 0) {
    document.body.style.zoom = String(scale);
  }

  var card = document.getElementById('card');
  var badge = document.getElementById('badge');
  var timer = document.getElementById('timer');
  var question = document.getElementById('question');
  var clock = document.getElementById('clock');
  var options = document.getElementById('options');
  var footLeft = document.getElementById('footLeft');
  var footRight = document.getElementById('footRight');

  var state = null;
  var offset = 0;
  var failures = 0;
  var shownId = null;
  var rows = [];
  var seen = [];

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function clockText(seconds) {
    var rest = seconds % 60;
    return Math.floor(seconds / 60) + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function voteHint(view) {
    if (view.mode === 'native') {
      return 'Vote in the Twitch poll';
    }
    var numbers = view.options.map(function (_, index) { return String(index + 1); });
    var last = numbers.pop();
    return 'Type ' + numbers.join(', ') + ' or ' + last + ' in chat to vote';
  }

  function part(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function build(view) {
    options.textContent = '';
    rows = view.options.map(function (option, index) {
      var row = part('div', 'opt');
      var count = part('div', 'count');
      var bar = part('div', 'bar');
      var fill = document.createElement('i');
      bar.appendChild(fill);
      row.append(part('div', 'num', String(index + 1)), part('div', 'title', option.title), count, bar);
      options.appendChild(row);
      return { row: row, count: count, fill: fill };
    });
    seen = view.options.map(function (option) { return option.votes; });
    question.textContent = view.question;
    shownId = view.id;
  }

  function paintOptions(view, done) {
    var top = Math.max.apply(null, view.options.map(function (option) { return option.votes; }));
    view.options.forEach(function (option, index) {
      var parts = rows[index];
      if (!parts) {
        return;
      }
      var share = view.total > 0 ? Math.round((option.votes / view.total) * 100) : 0;
      parts.count.textContent = String(option.votes);
      parts.count.appendChild(part('small', '', share + '%'));
      parts.fill.style.width = share + '%';
      parts.row.classList.toggle('lead', !done && view.total > 0 && option.votes === top);
      parts.row.classList.toggle('win', done && view.winner === index);
      if (option.votes > seen[index]) {
        parts.row.classList.remove('bump');
        void parts.row.offsetWidth;
        parts.row.classList.add('bump');
      }
      seen[index] = option.votes;
    });
  }

  function showPoll(poll, now) {
    if (shownId !== poll.id) {
      build(poll);
    }
    var left = Math.max(0, poll.endsAt - now);
    var seconds = Math.ceil(left / 1000);
    card.classList.remove('hidden', 'done');
    badge.textContent = 'Chat vote';
    timer.textContent = clockText(seconds);
    timer.className = 'timer' + (seconds <= 5 ? ' hot' : seconds <= 10 ? ' warn' : '');
    clock.style.transform = 'scaleX(' + (poll.seconds > 0 ? left / (poll.seconds * 1000) : 0) + ')';
    paintOptions(poll, false);
    footLeft.textContent = seconds > 0 ? voteHint(poll) : 'Counting the votes...';
    footRight.textContent = plural(poll.total, 'vote');
  }

  function showResult(result) {
    if (shownId !== result.id) {
      build(result);
    }
    card.classList.remove('hidden');
    card.classList.add('done');
    timer.className = 'timer final';
    timer.textContent = 'Final';
    paintOptions(result, true);
    footLeft.textContent = '';
    footRight.textContent = '';
    if (result.outcome === 'decided') {
      var winner = result.options[result.winner];
      badge.textContent = 'Chat has spoken';
      footLeft.append('Winner: ', part('b', '', winner.title));
      footRight.textContent =
        winner.votes + ' of ' + plural(result.total, 'vote') + (result.tied ? ' (tie, drawn by lot)' : '');
    } else if (result.outcome === 'no_votes') {
      badge.textContent = 'Nobody voted';
      footLeft.textContent = 'No votes came in this time';
    } else if (result.outcome === 'cancelled') {
      badge.textContent = 'Vote called off';
      timer.className = 'timer';
      timer.textContent = 'Off';
      footLeft.textContent = 'This vote was called off';
    } else {
      badge.textContent = 'Vote closed';
      footLeft.textContent = 'The result is on Twitch';
    }
  }

  function render() {
    var now = Date.now() + offset;
    if (state && state.poll) {
      showPoll(state.poll, now);
      return;
    }
    var result = state && state.result;
    var hold = result && result.outcome === 'cancelled' ? Math.min(holdMs, 5000) : holdMs;
    if (result && now - result.closedAt < hold) {
      showResult(result);
      return;
    }
    card.classList.add('hidden');
  }

  var demoStart = Date.now();
  var demoRound = -1;
  var demoVotes = [];
  var DEMO_SECONDS = 20;
  var DEMO_QUESTION = 'Should Halley move in with Anker?';
  var DEMO_OPTIONS = ['Move in together', 'Wait until they are engaged', 'Break it off'];

  function demoState() {
    var now = Date.now();
    var cycle = (DEMO_SECONDS + 16) * 1000;
    var round = Math.floor((now - demoStart) / cycle);
    var into = (now - demoStart) % cycle;
    var endsAt = now - into + DEMO_SECONDS * 1000;
    if (round !== demoRound) {
      demoRound = round;
      demoVotes = DEMO_OPTIONS.map(function () { return 0; });
    }
    if (into < DEMO_SECONDS * 1000 && Math.random() < 0.6) {
      var pick = Math.random();
      demoVotes[pick < 0.45 ? 0 : pick < 0.8 ? 1 : 2] += 1;
    }
    var view = {
      id: 'demo-' + round,
      question: DEMO_QUESTION,
      mode: 'chat',
      options: DEMO_OPTIONS.map(function (title, index) { return { title: title, votes: demoVotes[index] }; }),
      total: demoVotes.reduce(function (sum, count) { return sum + count; }, 0),
    };
    if (into < DEMO_SECONDS * 1000) {
      view.seconds = DEMO_SECONDS;
      view.endsAt = endsAt;
      return { now: now, poll: view };
    }
    var top = Math.max.apply(null, demoVotes);
    view.closedAt = endsAt;
    view.outcome = view.total > 0 ? 'decided' : 'no_votes';
    view.winner = view.total > 0 ? demoVotes.indexOf(top) : undefined;
    return { now: now, result: view };
  }

  function refresh() {
    var next = demo
      ? Promise.resolve(demoState())
      : fetch('/overlay/poll/state', { cache: 'no-store' }).then(function (response) {
          if (!response.ok) {
            throw new Error('status ' + response.status);
          }
          return response.json();
        });
    next
      .then(function (fresh) {
        state = fresh;
        offset = fresh.now - Date.now();
        failures = 0;
      })
      .catch(function () {
        failures += 1;
        if (failures >= 3) {
          state = null;
        }
      })
      .then(function () {
        setTimeout(refresh, 500);
      });
  }

  setInterval(render, 100);
  refresh();
})();
</script>
</body>
</html>
`;
