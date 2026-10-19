'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let user = null, authMode = 'login', boardMode = 'global', boardVersion = 0;
  let currentRun = null, saving = false;
  const pendingSaves = [];
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const pad = number => String(number).padStart(6, '0');
  const date = value => new Date(value * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dialog = $('auth-dialog');

  async function api(path, data) {
    let response;
    try {
      response = await fetch(`/api/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Rasteroids-Request': '1' },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Mission control is unreachable. Check your connection and retry.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Online features need the Rasteroids server. Run python3 server.py.'); }
    if (!response.ok) throw new Error(result.error || 'Request failed. Please retry.');
    return result;
  }

  function notice(message) { $('save-status').textContent = message; }
  function renderUser() {
    $('account-button').textContent = user ? `PILOT / ${user.username}` : 'SIGN IN / JOIN →';
    $('logout-button').hidden = !user;
    $('join-button').hidden = !!user;
    $('pilot-name').textContent = user ? user.username : 'GUEST PILOT';
    $('pilot-caption').textContent = user ? 'Cleared for the next flight.' : 'Every legend starts at zero.';
    $('profile-note').textContent = user ? 'Flights launched while signed in save automatically at game over.' : 'Save your scores. Make the board. Come back for more.';
    if (!user) {
      $('personal-best').textContent = '—';
      $('flight-count').textContent = '—';
    }
  }

  async function loadProfile() {
    const owner = user?.id;
    if (!owner) return;
    try {
      const { stats } = await api('scores');
      if (user?.id !== owner) return;
      $('personal-best').textContent = pad(stats.best);
      $('flight-count').textContent = stats.flights;
      window.dispatchEvent(new CustomEvent('rasteroids:profile', { detail: { best: stats.best } }));
    } catch (error) { $('profile-note').textContent = error.message; }
  }

  async function loadBoard() {
    const version = ++boardVersion, mode = boardMode;
    $('global-tab').setAttribute('aria-pressed', mode === 'global');
    $('history-tab').setAttribute('aria-pressed', mode === 'history');
    $('board-footnote').textContent = mode === 'global' ? 'BEST FLIGHTS FIRST · UP TO 50 PILOTS' : 'YOUR 20 MOST RECENT COMPLETED FLIGHTS';
    $('scoreboard').replaceChildren();
    if (mode === 'history' && !user) {
      $('board-message').textContent = 'Sign in to see your flight history. Your next great run deserves a record.';
      return;
    }
    $('board-message').textContent = 'Receiving flight records…';
    try {
      const result = await api(mode === 'global' ? 'leaderboard' : 'scores');
      if (version !== boardVersion) return;
      const entries = mode === 'global' ? result.entries : result.scores;
      $('board-message').textContent = entries.length ? '' : mode === 'global' ? 'Uncharted territory. Create a pilot account to join the board.' : 'Your flight log is empty. Launch a game and see how far you get.';
      entries.forEach((entry, index) => {
        const row = document.createElement('li');
        row.className = `score-row${mode === 'history' || entry.username === user?.username ? ' mine' : ''}`;
        const unflown = mode === 'global' && entry.score === null;
        const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = unflown ? '—' : String(index + 1).padStart(2, '0');
        const pilot = document.createElement('span'); pilot.className = 'pilot';
        pilot.textContent = mode === 'global' ? entry.username : date(entry.finished_at);
        const detail = document.createElement('small');
        detail.textContent = unflown ? 'NO FLIGHTS YET' : `SECTOR ${String(entry.sector).padStart(2, '0')} · ${mode === 'global' ? date(entry.finished_at) : `${entry.duration}s IN ORBIT`}`;
        pilot.append(detail);
        const score = document.createElement('strong'); score.textContent = unflown ? '—' : pad(entry.score);
        row.append(rank, pilot, score); $('scoreboard').append(row);
      });
    } catch (error) { if (version === boardVersion) $('board-message').textContent = error.message; }
  }

  function setAuthMode(mode) {
    authMode = mode;
    $('auth-title').textContent = mode === 'login' ? 'WELCOME BACK.' : 'CLAIM YOUR CALLSIGN.';
    $('auth-copy').textContent = mode === 'login' ? 'Sign in to log your flights and chase your personal best.' : 'Create your pilot account. The scoreboard is waiting.';
    $('auth-submit').textContent = mode === 'login' ? 'SIGN IN →' : 'CREATE ACCOUNT →';
    $('auth-switch').textContent = mode === 'login' ? 'NEW PILOT? CREATE AN ACCOUNT' : 'ALREADY A PILOT? SIGN IN';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('auth-error').textContent = '';
  }
  function openAuth(mode) {
    if (user) { $('pilot-name').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    window.dispatchEvent(new Event('rasteroids:account-open'));
    setAuthMode(mode); dialog.showModal(); $('username').focus();
  }
  $('account-button').addEventListener('click', () => openAuth('login'));
  $('join-button').addEventListener('click', () => openAuth('register'));
  $('close-auth').addEventListener('click', () => dialog.close());
  $('auth-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('auth-submit').disabled = true; $('auth-switch').disabled = true; $('auth-error').textContent = '';
    try {
      const result = await api(authMode === 'login' ? 'login' : 'register', { username: $('username').value, password: $('password').value });
      user = result.user; $('password').value = ''; dialog.close(); renderUser();
      notice('Pilot connected · Launch a new flight to save your score.');
      await Promise.all([loadProfile(), loadBoard()]);
    } catch (error) { $('auth-error').textContent = error.message; }
    finally { $('auth-submit').disabled = false; $('auth-switch').disabled = false; }
  });
  dialog.addEventListener('close', () => { $('password').value = ''; });
  $('logout-button').addEventListener('click', async () => {
    $('logout-button').disabled = true;
    try {
      await api('logout', {}); user = null; pendingSaves.length = 0; $('retry-save').hidden = true;
      renderUser(); notice('Signed out · Guest flights are not saved.'); await loadBoard();
    } catch (error) { notice(error.message); }
    finally { $('logout-button').disabled = false; }
  });
  $('global-tab').addEventListener('click', () => { boardMode = 'global'; loadBoard(); });
  $('history-tab').addEventListener('click', () => { boardMode = 'history'; loadBoard(); });
  $('refresh-board').addEventListener('click', () => { loadBoard(); loadProfile(); });

  async function saveFlight(flight) {
    if (saving) return;
    if (user?.id !== flight.owner) { notice('Sign in as the pilot who launched this flight to save it.'); return; }
    saving = true; $('retry-save').hidden = true; notice('Transmitting flight record…');
    try {
      const result = await flight.token;
      if (result.error) {
        if (pendingSaves[0] === flight) pendingSaves.shift();
        notice('Flight was not registered at launch. Start a new game while connected to save scores.');
        return;
      }
      await api('scores', { runId: result.runId, ...flight.result });
      if (pendingSaves[0] === flight) pendingSaves.shift();
      notice(`Flight logged · ${pad(flight.result.score)} points. Ready for another?`);
      await Promise.all([loadProfile(), loadBoard()]);
    } catch (error) {
      notice(`Score not saved: ${error.message}`);
      $('retry-save').hidden = false;
    } finally {
      saving = false;
      if (pendingSaves.length && pendingSaves[0] !== flight) saveFlight(pendingSaves[0]);
    }
  }
  $('retry-save').addEventListener('click', () => { if (pendingSaves.length) saveFlight(pendingSaves[0]); });

  window.rasteroidsAccount = {
    ready,
    beginRun() {
      // Keep a failed save available until retried; never overwrite its result.
      currentRun = { owner: user?.id, started: performance.now(), token: user ? api('runs', {}).catch(error => ({ error })) : null };
      if (!pendingSaves.length) notice(user ? 'Pilot connected · This flight will save at game over.' : 'Guest flight · Sign in before your next launch to save scores.');
    },
    finishRun(score, sector) {
      const flight = currentRun; currentRun = null;
      if (!flight?.owner) { notice('Guest flight complete · Create a pilot account to save future scores.'); return; }
      flight.result = { score, sector, duration: Math.floor((performance.now() - flight.started) / 1000) };
      pendingSaves.push(flight);
      saveFlight(pendingSaves[0]);
    },
  };

  (async () => {
    try { user = (await api('me')).user; renderUser(); if (user) notice('Pilot connected · Your next flight will save automatically.'); }
    catch (error) { notice(error.message); }
    finally { resolveReady(); }
    await Promise.all([loadProfile(), loadBoard()]);
  })();
})();
