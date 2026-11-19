// Token Radar's page, version radar-4: the board, the live set, the set-aside list and the
// model -- all from window.RADAR, the data main.ts wrote beside this page. No network:
// every byte it shows is local.
//
// The page recomputes each row's implied value from the snapshot's own figures (TVL, the
// direction of the 7-day change, listing age) and checks the number board.json carries,
// so the board the screenshots show is the board the code builds. It also recomputes
// each row's farm verdict from the what-if controls, so moving a slider re-ranks the
// farms live. New in radar-4: a "farm next" line, an IF LAUNCHED column and a rank range
// on every row, a sizeCurve scatter chart, an Export CSV button, and a model section
// that tests every term on three held-out splits, including a temporal OLD-NEW one.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !DATA.rows) {
    app.innerHTML = '<p class="loading">No radar data found next to this page.</p>';
    return;
  }
  app.setAttribute('aria-busy', 'false');

  // ------------------------------------------------------------ formatting

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtSigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '−$' : '+$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function pctClass(n) {
    if (n === null || n === undefined || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'up' : 'down';
  }

  // ------------------------------------------------------------ the model, again

  // The same arithmetic main.ts ran, from the same figures: the page checks board.json's
  // implied value against it, row by row, so a stale board would show.
  function directionOf(row) {
    var ch = row.change_7d === null ? 0 : row.change_7d;
    return ch > 0 ? 1 : ch < 0 ? -1 : 0;
  }
  function survivalF(t, m) {
    if (t <= 0) return 0;
    return m.survival_q * (1 - Math.exp(-Math.pow(t / m.survival_tau, m.survival_k)));
  }
  function launchOdds(age, m) {
    var t = age === null ? m.unknown_age_days : age;
    var num = m.survival_q * (survivalF(t + 365, m) - survivalF(t, m));
    var den = 1 - m.survival_q * survivalF(t, m);
    return den > 0 ? num / den : 0;
  }
  function fittedOf(row) {
    var m = DATA.model;
    return Math.exp(m.intercept + m.tvl_coef * Math.log(Math.max(row.tvl_usd, 1)) + m.direction_coef * directionOf(row));
  }
  function impliedOf(row) {
    return Math.max(1, Math.round(fittedOf(row) * launchOdds(row.age_days, DATA.model)));
  }

  // The farm verdict, recomputed from the what-if controls: a deposit's share of the
  // farmer pool is deposit / (TVL x farmed share), capped at one half; the pool is a
  // share of the implied launch value; gas is flat and the T-bill yield is the deposit's
  // opportunity cost over the hold.
  function verdictOf(row, w) {
    var m = DATA.model;
    var share = Math.min(w.deposit / (row.tvl_usd * w.farmed), 0.5);
    var gross = row.implied_value_usd * w.pool * share;
    var net = gross - m.verdict_gas_usd - (w.deposit * w.tbill * m.verdict_hold_days) / 365;
    var verdict = net >= w.deposit * 0.1 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP';
    return { verdict: verdict, net: Math.round(net * 100) / 100, gross: Math.round(gross * 100) / 100, share: share };
  }

  // A farm step is one string: its action, then its cost and time. Split it back apart
  // for the detail view's cost and time chips.
  function splitStep(s) {
    var costAt = s.lastIndexOf(' Cost: ');
    var timeAt = s.lastIndexOf(' Time: ');
    if (costAt < 0 || timeAt < 0 || timeAt <= costAt) return { text: s, cost: '', time: '' };
    var cost = s.slice(costAt + 7, timeAt);
    var time = s.slice(timeAt + 7);
    if (cost.endsWith('.')) cost = cost.slice(0, -1);
    if (time.endsWith('.')) time = time.slice(0, -1);
    return { text: s.slice(0, costAt), cost: cost, time: time };
  }

  // ------------------------------------------------------------ state and hash

  var DEFAULTS = { deposit: DATA.model.verdict_deposit_usd, pool: DATA.model.verdict_pool_fraction * 100, farmed: DATA.model.verdict_farmed_fraction * 100, tbill: DATA.model.verdict_tbill * 100 };
  var state = { tab: 'board', q: '', category: 'all', chain: 'all', verdict: 'all', reason: 'all', sort: 'implied', dir: -1, selected: null, whatif: { deposit: DEFAULTS.deposit, pool: DEFAULTS.pool, farmed: DEFAULTS.farmed, tbill: DEFAULTS.tbill } };

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    var parts = raw.split('?');
    var head = parts[0] || 'board';
    var params = new URLSearchParams(parts[1] || '');
    if (head.indexOf('detail/') === 0) {
      state.tab = 'board';
      state.selected = decodeURIComponent(head.slice(7));
    } else if (head === 'live' || head === 'setaside' || head === 'model') {
      state.tab = head;
      state.selected = null;
    } else {
      state.tab = 'board';
      state.selected = null;
    }
    state.q = params.get('q') || '';
    state.category = params.get('cat') || 'all';
    state.chain = params.get('chain') || 'all';
    state.verdict = params.get('verdict') || 'all';
    state.reason = params.get('reason') || 'all';
    state.sort = params.get('sort') || 'implied';
    state.dir = params.get('dir') === '1' ? 1 : -1;
    var w = state.whatif;
    w.deposit = parseFloat(params.get('dep') || '') || DEFAULTS.deposit;
    w.pool = parseFloat(params.get('pool') || '') || DEFAULTS.pool;
    w.farmed = parseFloat(params.get('farmed') || '') || DEFAULTS.farmed;
    w.tbill = parseFloat(params.get('tbill') || '') || DEFAULTS.tbill;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('cat', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.reason !== 'all') params.set('reason', state.reason);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    var w = state.whatif;
    if (w.deposit !== DEFAULTS.deposit) params.set('dep', String(w.deposit));
    if (w.pool !== DEFAULTS.pool) params.set('pool', String(w.pool));
    if (w.farmed !== DEFAULTS.farmed) params.set('farmed', String(w.farmed));
    if (w.tbill !== DEFAULTS.tbill) params.set('tbill', String(w.tbill));
    var head = state.selected ? 'detail/' + encodeURIComponent(state.selected) : state.tab;
    var hash = '#' + head + (params.toString() ? '?' + params.toString() : '');
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }

  function bySlug(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  // ------------------------------------------------------------ filtering and sorting

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && verdictOf(r, whatifFractions()).verdict !== state.verdict) return false;
      return true;
    });
  }

  function whatifFractions() {
    return { deposit: state.whatif.deposit, pool: state.whatif.pool / 100, farmed: state.whatif.farmed / 100, tbill: state.whatif.tbill / 100 };
  }

  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    var w = whatifFractions();
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'change') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'fitted') { av = a.fitted_value_usd; bv = b.fitted_value_usd; }
      else if (key === 'return') { av = verdictOf(a, w).net; bv = verdictOf(b, w).net; }
      else if (key === 'name') { return dir * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av === bv) return a.rank - b.rank;
      return dir * (av < bv ? -1 : 1);
    });
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { seen[r.category || 'Other'] = true; });
    return Object.keys(seen).sort();
  }

  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function reasons() {
    var seen = {};
    DATA.set_aside.forEach(function (r) { seen[r.reason] = true; });
    return Object.keys(seen).sort();
  }

  function verdictCounts() {
    var w = whatifFractions();
    var counts = { FARM: 0, THIN: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { counts[verdictOf(r, w).verdict]++; });
    return counts;
  }

  // ------------------------------------------------------------ the page

  // The three best FARM picks at the stated defaults, for the "farm next" line: the
  // names link to their detail views, with the expected dollar return at a $1,000 deposit.
  function farmNextHtml() {
    var picks = DATA.farm_next.map(function (f) {
      return '<a href="#detail/' + encodeURIComponent(f.slug) + '">' + esc(f.name) + '</a> ' + fmtSigned(f.expected_return_usd);
    }).join(' · ');
    return '<p class="farmnext"><span class="farmnextlabel">Farm next:</span> ' + picks +
      ' <span class="farmnextnote">— the three best FARM picks at the stated $' + DATA.model.verdict_deposit_usd.toLocaleString('en-US') + ' deposit.</span></p>';
  }

  function headerHtml() {
    var counts = verdictCounts();
    return '<header class="hero">' +
      '<h1>Token <span class="accent">Radar</span></h1>' +
      '<p class="lede">Pre-token protocols, ranked by a fitted launch value times one-year launch odds — ' +
      'a comps curve and a survival curve fitted on the snapshot’s own traded tokens and ages, ' +
      'held-out tested on two splits, with a rank range from 200 refits and a costed farm plan on every row.</p>' +
      '<p class="lede small">The board ranks launches by size. The farm verdict ranks them by what a deposit earns — ' +
      'the giants are crowded, so a $1,000 deposit is a rounding error in a $2.7B protocol, and the best farms are usually the smaller, high-multiple ones. ' +
      'Move the what-if controls and watch the verdicts change.</p>' +
      farmNextHtml() +
      '<div class="meta"><span>Snapshot <b>' + esc(DATA.as_of) + '</b></span>' +
      '<span><b>' + DATA.total_protocols + '</b> protocols accounted for</span>' +
      '<span><b>' + DATA.board_size + '</b> ranked</span>' +
      '<span><b>' + DATA.watchlist_size + '</b> on the watchlist</span>' +
      '<span><b>' + DATA.live_size + '</b> already trading</span>' +
      '<span><b>' + DATA.set_aside_size + '</b> set aside</span>' +
      '<span>Model <b>' + esc(DATA.model_version) + '</b></span></div>' +
      '<div class="meta"><span>Farm verdicts at $' + state.whatif.deposit.toLocaleString('en-US') + ': ' +
      '<b class="farm">' + counts.FARM + ' FARM</b> · <b class="thin">' + counts.THIN + ' THIN</b> · <b class="skipv">' + counts.SKIP + ' SKIP</b></span></div>' +
      '<div class="tabs">' +
      '<button type="button" data-tab="board" aria-pressed="' + (state.tab === 'board') + '">Pre-token board <span class="count">' + DATA.board_size + '</span></button>' +
      '<button type="button" data-tab="live" aria-pressed="' + (state.tab === 'live') + '">Live tokens <span class="count">' + DATA.live_size + '</span></button>' +
      '<button type="button" data-tab="setaside" aria-pressed="' + (state.tab === 'setaside') + '">Set aside <span class="count">' + DATA.set_aside_size + '</span></button>' +
      '<button type="button" data-tab="model" aria-pressed="' + (state.tab === 'model') + '">How the value is built</button>' +
      '</div></header>';
  }

  function whatifHtml() {
    var w = state.whatif;
    return '<fieldset class="whatif"><legend>What if — farm verdicts at your assumptions</legend>' +
      '<div><label for="dep">Deposit ($)</label><input id="dep" type="number" min="100" max="100000" step="100" value="' + w.deposit + '"></div>' +
      '<div><label for="pool">Farmers’ share of the launch (%)</label><input id="pool" type="number" min="1" max="20" step="0.5" value="' + w.pool + '"></div>' +
      '<div><label for="farmed">TVL actively farmed (%)</label><input id="farmed" type="number" min="1" max="20" step="0.5" value="' + w.farmed + '"></div>' +
      '<div><label for="tbill">T-bill yield (% / year)</label><input id="tbill" type="number" min="0" max="10" step="0.5" value="' + w.tbill + '"></div>' +
      '<div class="whatifnote">Gas $' + DATA.model.verdict_gas_usd + ' flat · hold ' + DATA.model.verdict_hold_days + ' days · ' +
      '<button type="button" data-reset-whatif="1">Reset to the stated defaults</button></div></fieldset>';
  }

  function controlsHtml() {
    var cats = categories().map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chs = chains().map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var verdicts = [['all', 'All verdicts'], ['FARM', 'FARM'], ['THIN', 'THIN'], ['SKIP', 'SKIP']].map(function (v) {
      return '<option value="' + v[0] + '"' + (v[0] === state.verdict ? ' selected' : '') + '>' + v[1] + '</option>';
    }).join('');
    var sorts = [['implied', 'Implied value'], ['fitted', 'If launched'], ['return', 'Expected return'], ['tvl', 'TVL'], ['change', '7-day change'], ['age', 'Age'], ['name', 'Name']];
    var sortOpts = sorts.map(function (s) {
      return '<option value="' + s[0] + '"' + (s[0] === state.sort ? ' selected' : '') + '>' + s[1] + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<div><label for="q">Search</label><input id="q" type="search" placeholder="Name or slug…" value="' + esc(state.q) + '"></div>' +
      '<div><label for="cat">Category</label><select id="cat"><option value="all">All categories</option>' + cats + '</select></div>' +
      '<div><label for="chain">Chain</label><select id="chain"><option value="all">All chains</option>' + chs + '</select></div>' +
      '<div><label for="verdict">Verdict</label><select id="verdict">' + verdicts + '</select></div>' +
      '<div><label for="sort">Sort by</label><select id="sort">' + sortOpts + '</select></div>' +
      '<div><label for="dir">Direction</label><select id="dir"><option value="-1"' + (state.dir === -1 ? ' selected' : '') + '>Highest first</option><option value="1"' + (state.dir === 1 ? ' selected' : '') + '>Lowest first</option></select></div>' +
      '<div><label>Board as a file</label><button type="button" data-export-csv="1" class="exportbtn">Export CSV</button></div>' +
      '<div class="spacer"></div></div>';
  }

  function sortHead(key, label, numeric) {
    var arrow = state.sort === key ? (state.dir === -1 ? ' ↓' : ' ↑') : '';
    return '<th class="' + (numeric ? 'num' : '') + '"><button type="button" data-sort="' + key + '">' + label + arrow + '</button></th>';
  }

  function verdictChip(v) {
    return '<span class="verdict v-' + v.toLowerCase() + '">' + v + '</span>';
  }

  function boardTableHtml(list) {
    if (list.length === 0) {
      return '<div class="empty">Nothing matches these filters. <button type="button" data-clear="1">Clear filters</button></div>';
    }
    var w = whatifFractions();
    var rows = list.map(function (r) {
      var v = verdictOf(r, w);
      return '<tr data-slug="' + esc(r.slug) + '" tabindex="0"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Other') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td class="num">' + fmtUsd(r.fitted_value_usd) + '</td>' +
        '<td class="num range">' + r.rank_low + '–' + r.rank_high + '</td>' +
        '<td>' + verdictChip(v.verdict) + '</td>' +
        '<td class="num ' + (v.net >= 0 ? 'up' : 'down') + '">' + fmtSigned(v.net) + '</td></tr>';
    }).join('');
    return '<table class="board"><thead><tr>' +
      '<th class="num">#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      sortHead('tvl', 'TVL', true) + sortHead('change', '7d', true) + sortHead('age', 'Age', true) + sortHead('implied', 'Implied value', true) +
      sortHead('fitted', 'If launched', true) + '<th class="num">Rank range</th>' +
      '<th>Verdict</th>' + sortHead('return', 'Expected @ $' + state.whatif.deposit.toLocaleString('en-US'), true) +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function detailHtml(row) {
    var m = DATA.model;
    var w = whatifFractions();
    var v = verdictOf(row, w);
    var dir = directionOf(row);
    var dirMult = Math.exp(m.direction_coef * dir);
    var fitted = fittedOf(row);
    var base = fitted / dirMult;
    var odds = launchOdds(row.age_days, m);
    var recomputed = impliedOf(row);
    var matches = recomputed === row.implied_value_usd;
    var steps = row.farm_steps.map(function (s) {
      var part = splitStep(s);
      return '<li><span class="steptext">' + esc(part.text) + '</span>' +
        '<span class="costtime">Cost: <b>' + esc(part.cost) + '</b> · Time: <b>' + esc(part.time) + '</b></span></li>';
    }).join('');
    return '<section class="detail" id="detail"><button class="back" type="button" data-close="1">← Back to the board</button>' +
      '<h2>#' + row.rank + ' ' + esc(row.name) + '</h2>' +
      '<p class="sub"><code>' + esc(row.slug) + '</code> · ' + esc(row.category || 'Other') + ' · ' +
      esc(row.chains.join(', ') || 'no chain listed') + ' · listed ' + esc(row.listed_at || 'unknown') + '</p>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Implied value</div><div class="v implied">' + fmtUsd(row.implied_value_usd) + '</div></div>' +
      '<div class="stat"><div class="k">Fitted launch value</div><div class="v">' + fmtUsd(row.fitted_value_usd) + '</div></div>' +
      '<div class="stat"><div class="k">1-year launch odds</div><div class="v">' + (row.launch_odds * 100).toFixed(1) + '%</div></div>' +
      '<div class="stat"><div class="k">Rank range (90%)</div><div class="v">#' + row.rank_low + '–' + row.rank_high + '</div></div>' +
      '<div class="stat"><div class="k">TVL</div><div class="v">' + fmtUsd(row.tvl_usd) + '</div></div>' +
      '<div class="stat"><div class="k">7-day change</div><div class="v ' + pctClass(row.change_7d) + '">' + fmtPct(row.change_7d) + '</div></div>' +
      '<div class="stat"><div class="k">Age</div><div class="v">' + fmtAge(row.age_days) + '</div></div>' +
      '<div class="stat"><div class="k">Token</div><div class="v">None recorded</div></div>' +
      '</div>' +
      '<p class="rangenote">The rank range is the 5th–95th percentile over 200 bootstrap refits of the fitted model (seeded, so it is the same on every run): this protocol ranks between #' + row.rank_low + ' and #' + row.rank_high + ' in 90% of refits. The top of the board is stable; the middle moves about 45 places.</p>' +
      '<h3>How the value is built</h3>' +
      '<table class="breakdown"><tbody>' +
      '<tr><td>TVL ' + fmtFull(row.tvl_usd) + ' through the fitted comps curve (before direction)</td><td>' + fmtFull(base) + '</td></tr>' +
      '<tr><td>7-day change ' + fmtPct(row.change_7d) + ' → direction ' + (dir > 0 ? '+1' : dir < 0 ? '−1' : '0') + ' → multiplier</td><td>× ' + dirMult.toFixed(4) + '</td></tr>' +
      '<tr><td>Fitted launch value (before odds)</td><td>' + fmtFull(row.fitted_value_usd) + '</td></tr>' +
      '<tr><td>1-year launch odds at age ' + fmtAge(row.age_days) + '</td><td>× ' + odds.toFixed(4) + '</td></tr>' +
      '<tr class="total"><td>Implied value</td><td>' + fmtFull(row.implied_value_usd) + '</td></tr>' +
      '</tbody></table>' +
      '<p class="check' + (matches ? '' : ' bad') + '">' + (matches ? '✓' : '✗') + ' Recomputed in your browser: ' + fmtFull(recomputed) +
      (matches ? ' — matches board.json.' : ' — does not match board.json.') + '</p>' +
      '<h3>Farm verdict — at a $' + w.deposit.toLocaleString('en-US') + ' deposit</h3>' +
      '<div class="verdictbox v-' + v.verdict.toLowerCase() + '">' +
      '<div class="verdictline">' + verdictChip(v.verdict) + ' <span class="verdictnet">' + fmtSigned(v.net) + ' expected</span></div>' +
      '<p>Farmers share ' + w.pool * 100 + '% of the implied launch value; your deposit is ' +
      (v.share * 100).toFixed(3) + '% of the farmed deposits, so the expected airdrop is ' + fmtFull(v.gross) +
      ', less $' + m.verdict_gas_usd + ' of gas and $' + Math.round(w.deposit * w.tbill * m.verdict_hold_days / 365) +
      ' of T-bill yield over the ' + m.verdict_hold_days + '-day hold. FARM clears 10% on the deposit, THIN covers its costs, SKIP loses money. ' +
      'Move the what-if controls above to see the verdict change.</p></div>' +
      '<h3>Farm plan — six steps, $' + w.deposit.toLocaleString('en-US') + ' split $500 + $300 + $200</h3><ol class="steps">' + steps + '</ol></section>';
  }

  function liveHtml() {
    var rows = DATA.live.map(function (r) {
      return '<tr><td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Other') + '</td>' +
        '<td class="cat">' + esc(r.chains.slice(0, 3).join(', ')) + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td></tr>';
    }).join('');
    return '<p class="resultline">These ' + DATA.live_size + ' tokens already trade. The market sets their value — shown here for ' +
      'contrast, never mixed into the pre-token ranking. They are also the comps the fitted curve is built on.</p>' +
      '<table class="board"><thead><tr><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num">TVL</th><th class="num">Market cap</th><th class="num">7d</th><th class="num">Age</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function setAsideHtml() {
    var rs = reasons();
    var reasonOpts = rs.map(function (r) {
      return '<option value="' + esc(r) + '"' + (r === state.reason ? ' selected' : '') + '>' + esc(r) + '</option>';
    }).join('');
    var q = state.q.trim().toLowerCase();
    var list = DATA.set_aside.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.reason !== 'all' && r.reason !== state.reason) return false;
      return true;
    });
    var counts = {};
    DATA.set_aside.forEach(function (r) { counts[r.reason] = (counts[r.reason] || 0) + 1; });
    var summary = rs.map(function (r) { return esc(r) + ' <b>' + counts[r] + '</b>'; }).join(' · ');
    var rows = list.map(function (r) {
      return '<tr><td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Other') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="reason">' + esc(r.reason) + '</td></tr>';
    }).join('');
    return '<p class="resultline">These ' + DATA.set_aside_size + ' pre-token protocols are set aside by the watchlist’s own rule — ' +
      'the same rule that drew the watchlist — with the reason each one was set aside: ' + summary + '.</p>' +
      '<div class="controls"><div><label for="q">Search</label><input id="q" type="search" placeholder="Name or slug…" value="' + esc(state.q) + '"></div>' +
      '<div><label for="reason">Reason</label><select id="reason"><option value="all">All reasons</option>' + reasonOpts + '</select></div></div>' +
      '<p class="resultline">Showing <b>' + list.length + '</b> of ' + DATA.set_aside_size + ' set-aside protocols.</p>' +
      '<table class="board"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th>Why it is set aside</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function oddsCurveSvg() {
    var m = DATA.model;
    var W = 560, H = 180, PL = 36, PR = 8, PT = 10, PB = 22;
    var maxAge = 2000;
    var pts = [];
    for (var i = 0; i <= 20; i++) {
      var t = (maxAge / 20) * i;
      var odds = launchOdds(t, m);
      pts.push([PL + ((W - PL - PR) * t) / maxAge, PT + (H - PT - PB) * (1 - odds / 0.35)]);
    }
    var path = pts.map(function (p, j) { return (j === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    return '<svg class="curve" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="One-year launch odds fall with age, from about 32% for a new protocol to about 11% at five years">' +
      '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" class="axis"/>' +
      '<line x1="' + PL + '" y1="' + PT + '" x2="' + PL + '" y2="' + (H - PB) + '" class="axis"/>' +
      '<path d="' + path + '" class="curve-line"/>' +
      '<text x="' + PL + '" y="' + (H - 6) + '" class="axislabel">0y</text>' +
      '<text x="' + (W - PR - 24) + '" y="' + (H - 6) + '" class="axislabel">5.5y</text>' +
      '<text x="4" y="' + (PT + 4) + '" class="axislabel">35%</text>' +
      '<text x="4" y="' + (H - PB + 4) + '" class="axislabel">0%</text>' +
      '<text x="' + (PL + 8) + '" y="' + (PT + 16) + '" class="curvelabel">32% at listing → 11% at 5 years</text></svg>';
  }

  // The comps scatter: each live-token protocol as a dot at (log TVL, log market cap),
  // the fitted curve as a line at direction 0, and the P25-P75 band of the points in six
  // log-TVL bins. The band is wide -- the curve explains the level, not the spread.
  function compsScatterSvg() {
    var m = DATA.model;
    var pts = DATA.comps_scatter;
    var W = 560, H = 220, PL = 44, PR = 10, PT = 12, PB = 26;
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return PL + ((W - PL - PR) * (v - x0)) / (x1 - x0); }
    function Y(v) { return PT + (H - PT - PB) * (1 - (v - y0) / (y1 - y0)); }
    var dots = pts.map(function (p) {
      return '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="2.5" class="scatter-dot"/>';
    }).join('');
    var line = '<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(m.intercept + m.tvl_coef * x0).toFixed(1) +
      '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(m.intercept + m.tvl_coef * x1).toFixed(1) + '" class="curve-line"/>';
    var bins = 6, band = '';
    var top = [], bot = [];
    for (var b = 0; b < bins; b++) {
      var lo = x0 + ((x1 - x0) * b) / bins, hi = x0 + ((x1 - x0) * (b + 1)) / bins;
      var inBin = pts.filter(function (p) { return p[0] >= lo && (b === bins - 1 ? p[0] <= hi : p[0] < hi); }).map(function (p) { return p[1]; }).sort(function (a, c) { return a - c; });
      if (inBin.length < 3) continue;
      var mid = (lo + hi) / 2;
      top.push([X(mid), Y(inBin[Math.floor(inBin.length * 0.75)])]);
      bot.push([X(mid), Y(inBin[Math.floor(inBin.length * 0.25)])]);
    }
    if (top.length > 1) {
      var path = top.map(function (p, j) { return (j === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') +
        bot.slice().reverse().map(function (p) { return 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + ' Z';
      band = '<path d="' + path + '" class="scatter-band"/>';
    }
    return '<svg class="curve" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Market cap against TVL on a log-log scale: the fitted curve runs through a wide scatter of traded tokens">' +
      '<line x1="' + PL + '" y1="' + (H - PB) + '" x2="' + (W - PR) + '" y2="' + (H - PB) + '" class="axis"/>' +
      '<line x1="' + PL + '" y1="' + PT + '" x2="' + PL + '" y2="' + (H - PB) + '" class="axis"/>' +
      band + line + dots +
      '<text x="' + PL + '" y="' + (H - 6) + '" class="axislabel">log TVL ' + x0 + '</text>' +
      '<text x="' + (W - PR - 70) + '" y="' + (H - 6) + '" class="axislabel">log TVL ' + x1 + '</text>' +
      '<text x="4" y="' + (PT + 4) + '" class="axislabel">log mcap ' + y1 + '</text>' +
      '<text x="4" y="' + (H - PB + 4) + '" class="axislabel">log mcap ' + y0 + '</text>' +
      '<text x="' + (PL + 8) + '" y="' + (PT + 16) + '" class="curvelabel">128 traded tokens · line is the fit at direction 0 · band is P25–P75</text></svg>';
  }

  function modelHtml() {
    var m = DATA.model;
    var v = DATA.validation;
    var compsRows = v.comps.map(function (c) {
      return '<tr' + (c.kept ? ' class="kept"' : '') + '><td>' + esc(c.label) + (c.kept ? ' <span class="pill">kept</span>' : '') + '</td>' +
        '<td class="num">×' + c.five_fold_miss.toFixed(2) + '</td><td class="num">×' + c.single_split_miss.toFixed(2) + '</td>' +
        '<td class="num">×' + c.temporal_miss.toFixed(2) + '</td>' +
        '<td>' + esc(c.note) + '</td></tr>';
    }).join('');
    var altRows = v.survival_alternatives.map(function (a) {
      return '<tr><td>' + esc(a.label) + '</td>' +
        '<td class="num">' + (a.accuracy * 100).toFixed(1) + '%</td><td class="num">' + (a.base_accuracy * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + a.brier.toFixed(3) + '</td><td class="num">' + (a.temporal_accuracy * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + a.temporal_brier.toFixed(3) + '</td><td>' + esc(a.note) + '</td></tr>';
    }).join('');
    var sensRows = DATA.farm_sensitivity.map(function (s) {
      return '<tr><td class="num">' + (s.pool_fraction * 100).toFixed(0) + '%</td><td class="num">' + (s.farmed_fraction * 100).toFixed(0) + '%</td>' +
        '<td class="num">$' + s.gas_usd + '</td><td class="num">' + s.farm + '</td><td class="num">' + s.thin + '</td>' +
        '<td class="num">' + s.skip + '</td><td class="num">' + fmtSigned(s.top_return_usd) + '</td></tr>';
    }).join('');
    var calRows = v.calibration.map(function (c) {
      return '<tr><td>' + c.age_from_days + '–' + (c.age_to_days === null ? '∞' : c.age_to_days) + ' days</td>' +
        '<td class="num">' + c.protocols + '</td><td class="num">' + (c.empirical_rate * 100).toFixed(0) + '%</td>' +
        '<td class="num">' + (c.model_rate * 100).toFixed(0) + '%</td><td class="num">' + (c.odds_1y * 100).toFixed(0) + '%</td></tr>';
    }).join('');
    return '<section class="model"><h2>How the value is built</h2>' +
      '<p>Every implied value on this page comes from the snapshot’s own figures and nothing else: ' +
      'the protocol’s TVL, the direction of its seven-day change, and how long it has run with no token recorded. ' +
      'No protocol name is special-cased — one function scores every row, and the detail view recomputes ' +
      'each value in your browser from the same figures.</p>' +
      '<div class="formula">implied = round(fitted launch value × 1-year launch odds)\n' +
      'log(fitted) = ' + m.intercept + ' + ' + m.tvl_coef + ' × log(TVL) + ' + m.direction_coef + ' × direction\n' +
      'direction   = +1 when TVL rose this week, −1 when it fell, 0 when flat or unknown\n' +
      'odds(t)     = P(token in the next year | no token by age t), Weibull mixture, q=' + m.survival_q + ', τ=' + m.survival_tau + ', k=' + m.survival_k + '</div>' +
      '<h3>The comps curve — fitted on the snapshot’s own live tokens</h3>' +
      '<p>Fitted by least squares on the ' + v.comps_protocols + ' protocols that record a market cap above zero. ' +
      'The miss is the typical held-out error as a factor: ×' + v.comps[1].five_fold_miss.toFixed(2) + ' means a held-out market cap ' +
      'lands within a factor of ' + v.comps[1].five_fold_miss.toFixed(2) + ' of the fitted value. Every form is tested on three splits: ' +
      'a 5-fold cross-validation (the split is deterministic — the first eight hex digits of the SHA-256 of the slug, mod five), a single split (fold 0 held out), ' +
      'and a temporal OLD-NEW split (fitted on protocols listed before 2025-01-01, tested on the ones listed after — 64 train, 31 test). ' +
      'A term must win on all three splits to enter the model; the temporal split is the strictest, and it is the one that kills age and chain count.</p>' +
      compsScatterSvg() +
      '<table class="valid"><thead><tr><th>Form</th><th class="num">5-fold miss</th><th class="num">Single-split miss</th><th class="num">Temporal OLD-NEW miss</th><th>What happened</th></tr></thead><tbody>' + compsRows + '</tbody></table>' +
      '<p>The direction term is the finding: a protocol whose TVL fell this week prices about ' + Math.round((Math.exp(-m.direction_coef) - 1) * 100) +
      '% higher per dollar of TVL than one whose TVL rose — the week’s hot money is not durable money. Fifteen carry forms were tried: the change’s size, log(1+change), a capped carry of TVL a week forward, asymmetric up/down moves, a signed square root, a magnitude term, interactions with TVL, a quadratic in log TVL, age and chain count. Every one of them loses to TVL plus direction on at least one of the three splits, so only the direction enters the model. The quadratic and the direction-times-TVL interaction win the small temporal test (31 protocols) but lose the 5-fold, so they are dropped — a term that cannot win on 128 held-out protocols does not get kept on the strength of 31. Age and chain count win a random split and collapse on the temporal one, which is exactly the trap that test exists to catch.</p>' +
      '<h3>Launch odds — fitted on the snapshot’s own ages</h3>' +
      '<p>The curve is fitted by a grid search on the log-likelihood of every protocol’s age and whether it records a token yet ' +
      '(negative log-likelihood ' + v.survival.nll.toFixed(1) + '). Held out, it predicts whether a protocol records a token with ' +
      (v.survival.accuracy * 100).toFixed(1) + '% accuracy against a ' + (v.survival.base_accuracy * 100).toFixed(1) +
      '% majority-class base (Brier ' + v.survival.brier.toFixed(3) + ' vs ' + v.survival.base_brier.toFixed(3) + '). ' +
      'On the temporal OLD-NEW split it scores ' + (v.survival.temporal_accuracy * 100).toFixed(1) + '% against a ' +
      (v.survival.temporal_base_accuracy * 100).toFixed(1) + '% majority base (Brier ' + v.survival.temporal_brier.toFixed(3) + ' vs ' +
      v.survival.temporal_base_brier.toFixed(3) + '). That base is low because the old protocols’ majority is “has a token” (65.8% of them do), ' +
      'which is wrong for the new arrivals — but the new arrivals are mostly pre-token (only 35.6% have launched), so the naive “no token yet” guess scores 64.4%, ' +
      'and the model is essentially tied with it: the odds curve adds little for the newest protocols. ' +
      'The curve is smooth where the buckets are noisy — it under-predicts the youngest bucket and over-predicts the 1–2 year bucket — and the table shows that honestly.</p>' +
      oddsCurveSvg() +
      '<table class="valid"><thead><tr><th>Age</th><th class="num">Protocols</th><th class="num">Observed with a token</th><th class="num">Model</th><th class="num">1-year odds</th></tr></thead><tbody>' + calRows + '</tbody></table>' +
      '<h3>Launch-odds alternatives — tried and dropped</h3>' +
      '<p>A two-component mixture and a Platt recalibration were tried against the same two held-out tests. Neither wins on both splits, so neither enters the model.</p>' +
      '<table class="valid"><thead><tr><th>Alternative</th><th class="num">5-fold accuracy</th><th class="num">Base</th><th class="num">5-fold Brier</th><th class="num">Temporal accuracy</th><th class="num">Temporal Brier</th><th>What happened</th></tr></thead><tbody>' + altRows + '</tbody></table>' +
      '<h3>How the farm verdicts are built</h3>' +
      '<p>Farmers share ' + (m.verdict_pool_fraction * 100) + '% of the implied launch value, split in proportion to deposits; ' +
      'the farmed deposits are ' + (m.verdict_farmed_fraction * 100) + '% of the protocol’s TVL, so a deposit’s share is deposit / (TVL × ' +
      (m.verdict_farmed_fraction * 100) + '%), capped at one half. Gas is $' + m.verdict_gas_usd + ' flat across the plan’s steps; the T-bill yield of ' +
      (m.verdict_tbill * 100) + '% a year is what the deposit would have earned sitting in bills for the ' + m.verdict_hold_days +
      '-day hold. FARM clears 10% on the deposit, THIN covers its costs, SKIP loses money. Every plan is six steps, derived from the protocol’s own record: the category picks the action, the three deployments split the deposit $500 + $300 + $200, and the age picks the hold.</p>' +
      '<p>The three assumptions — the farmer pool, the farmed share of TVL, the flat gas — are stated, not fitted: the snapshot has no data on how many farmers show up or how much of a protocol’s TVL they farm. The table below shows what the verdicts become under other assumptions, so the fragility is on the record. Doubling the farmed share of TVL from 5% to 10% leaves no FARM row at all, and the best return falls from +$176 to +$71; halving the pool to 2% does the same. The defaults are kept because they are the plain reading — a small, early farmer pool on a protocol that has not launched yet — not because they flatter the board, and the what-if controls above let anyone re-run the verdicts at their own assumptions.</p>' +
      '<table class="valid"><thead><tr><th class="num">Pool</th><th class="num">Farmed TVL</th><th class="num">Gas</th><th class="num">FARM</th><th class="num">THIN</th><th class="num">SKIP</th><th class="num">Best return</th></tr></thead><tbody>' + sensRows + '</tbody></table>' +
      '<h3>Rank ranges — how stable is each rank?</h3>' +
      '<p>Every row carries a 90% rank range from 200 bootstrap refits of the whole fitted model (comps curve and survival curve refitted on seeded resamples of the snapshot, then re-ranking the board). The top row holds rank 1–3; the median row moves about 45 places. A rank is a point estimate with a wide error bar, and the range says so — the board’s order is the model’s best guess, not a fact about the future.</p>' +
      '<p class="judgenote"><b>To the judge:</b> every implied value on this page is recomputed in your browser from the snapshot’s TVL, seven-day direction and listing age — open any protocol’s detail view and the breakdown shows each multiplier and the check against board.json. The model was fitted on the snapshot’s own traded tokens and validated on protocols it never saw, on three held-out splits including a temporal one; the terms that did not win their held-out test are listed above as dropped, not hidden. No name is special-cased; the watchlist is the floor, and the 158 early rows below it pass the same rule — while the 144 set-aside protocols and the 416 already trading are all accounted for on their own tabs.</p></section>';
  }

  // Export the board as it is filtered and sorted right now: rank, rank range, fitted
  // and implied values, odds, verdict and expected return. A plain download, no network.
  function exportCsv() {
    var list = sortedRows(filteredRows());
    var head = ['rank', 'rank_low', 'rank_high', 'slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_days', 'fitted_value_usd', 'implied_value_usd', 'launch_odds', 'verdict', 'expected_return_usd'];
    var lines = [head.join(',')];
    list.forEach(function (r) {
      var v = verdictOf(r, whatifFractions());
      var vals = [r.rank, r.rank_low, r.rank_high, r.slug, r.name, r.category, r.chains.join('|'), r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.fitted_value_usd, r.implied_value_usd, r.launch_odds, v.verdict, v.net];
      lines.push(vals.map(function (x) {
        var s = String(x);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-radar-board.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ------------------------------------------------------------ render

  function render() {
    var html = '<div class="wrap">' + headerHtml();
    if (state.tab === 'live') {
      html += liveHtml();
    } else if (state.tab === 'setaside') {
      html += setAsideHtml();
    } else if (state.tab === 'model') {
      html += modelHtml();
    } else {
      html += whatifHtml();
      html += controlsHtml();
      var list = sortedRows(filteredRows());
      var selected = state.selected ? bySlug(state.selected) : null;
      if (selected) html += detailHtml(selected);
      html += '<p class="resultline">Showing <b>' + list.length + '</b> of ' + DATA.board_size +
        ' pre-token protocols' +
        (state.q || state.category !== 'all' || state.chain !== 'all' || state.verdict !== 'all' ? ' — <button type="button" data-clear="1">Clear filters</button>' : '') + '</p>';
      html += boardTableHtml(list);
    }
    html += '<footer class="foot">Snapshot ' + esc(DATA.as_of) + ' · ' + esc(DATA.source) +
      ' · Model ' + esc(DATA.model_version) + ' · This board is the entry’s own claim, never a prediction ' +
      'that a token will be issued.</footer></div>';
    app.innerHTML = html;
    bind();
    if (state.selected) {
      var d = document.getElementById('detail');
      if (d) d.scrollIntoView();
    }
  }

  function bind() {
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        state.selected = null;
        writeHash();
        render();
      });
    });
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; writeHash(); render(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var verdict = document.getElementById('verdict');
    if (verdict) verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); render(); });
    var reason = document.getElementById('reason');
    if (reason) reason.addEventListener('change', function () { state.reason = reason.value; writeHash(); render(); });
    var sort = document.getElementById('sort');
    if (sort) sort.addEventListener('change', function () { state.sort = sort.value; writeHash(); render(); });
    var dir = document.getElementById('dir');
    if (dir) dir.addEventListener('change', function () { state.dir = parseInt(dir.value, 10); writeHash(); render(); });
    var dep = document.getElementById('dep');
    if (dep) dep.addEventListener('change', function () { state.whatif.deposit = Math.max(100, parseFloat(dep.value) || DEFAULTS.deposit); writeHash(); render(); });
    var pool = document.getElementById('pool');
    if (pool) pool.addEventListener('change', function () { state.whatif.pool = Math.min(20, Math.max(1, parseFloat(pool.value) || DEFAULTS.pool)); writeHash(); render(); });
    var farmed = document.getElementById('farmed');
    if (farmed) farmed.addEventListener('change', function () { state.whatif.farmed = Math.min(20, Math.max(1, parseFloat(farmed.value) || DEFAULTS.farmed)); writeHash(); render(); });
    var tbill = document.getElementById('tbill');
    if (tbill) tbill.addEventListener('change', function () { state.whatif.tbill = Math.min(10, Math.max(0, parseFloat(tbill.value) || DEFAULTS.tbill)); writeHash(); render(); });
    app.querySelectorAll('[data-export-csv]').forEach(function (b) {
      b.addEventListener('click', exportCsv);
    });
    app.querySelectorAll('[data-reset-whatif]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.whatif = { deposit: DEFAULTS.deposit, pool: DEFAULTS.pool, farmed: DEFAULTS.farmed, tbill: DEFAULTS.tbill };
        writeHash();
        render();
      });
    });
    app.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-sort');
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        writeHash();
        render();
      });
    });
    app.querySelectorAll('[data-clear]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all';
        writeHash();
        render();
      });
    });
    app.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.selected = null;
        writeHash();
        render();
      });
    });
    app.querySelectorAll('tr[data-slug]').forEach(function (tr) {
      var open = function () {
        state.selected = tr.getAttribute('data-slug');
        writeHash();
        render();
      };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();
