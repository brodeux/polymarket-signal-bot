/**
 * Football data fetching and signal generation.
 * Uses API-Football via RapidAPI (api-football-v1.p.rapidapi.com).
 *
 * Required env: API_FOOTBALL_KEY — your RapidAPI key subscribed to API-Football
 * Subscribe at: https://rapidapi.com/api-sports/api/api-football
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const RAPIDAPI_HOST = 'api-football-v1.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/v3`;

// Throttle: wait ms between requests to stay within RapidAPI rate limits
const CALL_DELAY_MS = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function footballClient() {
  return axios.create({
    baseURL: RAPIDAPI_BASE,
    timeout: 12000,
    headers: {
      'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  });
}

/**
 * Calculate the current football season year.
 * Seasons start in July/August — so before August we're still in last year's season.
 * e.g. March 2026 → season 2025 (the 2025/26 season)
 */
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch live matches currently in progress.
 */
export async function fetchLiveMatches() {
  try {
    const { data } = await footballClient().get('/fixtures?live=all');
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error('[Football] API error on live matches:', JSON.stringify(data.errors));
      return [];
    }
    return data.response || [];
  } catch (err) {
    console.error('[Football] fetchLiveMatches error:', err.response?.status, err.message);
    return [];
  }
}

/**
 * Fetch today's fixtures from the top 5 European leagues.
 */
export async function fetchUpcomingFixtures() {
  const season = currentSeason();
  const today = new Date().toISOString().slice(0, 10);
  // EPL(39), La Liga(140), Bundesliga(78), Serie A(135), Ligue 1(61)
  const leagueIds = [39, 140, 78, 135, 61];
  const client = footballClient();
  const all = [];

  for (const league of leagueIds) {
    try {
      await sleep(CALL_DELAY_MS);
      const { data } = await client.get(`/fixtures?league=${league}&date=${today}&season=${season}`);
      if (data.response) all.push(...data.response);
    } catch (err) {
      console.error(`[Football] fetchUpcomingFixtures error for league ${league}:`, err.response?.status, err.message);
    }
  }

  return all;
}

/**
 * Fetch last 5 results for a team to determine recent form.
 */
async function fetchTeamForm(teamId) {
  const season = currentSeason();
  try {
    await sleep(CALL_DELAY_MS);
    const { data } = await footballClient().get(`/fixtures?team=${teamId}&last=5&season=${season}`);
    return data.response || [];
  } catch (err) {
    console.error(`[Football] fetchTeamForm error for team ${teamId}:`, err.response?.status, err.message);
    return [];
  }
}

/**
 * Fetch last 5 head-to-head meetings between two teams.
 */
async function fetchHeadToHead(team1Id, team2Id) {
  try {
    await sleep(CALL_DELAY_MS);
    const { data } = await footballClient().get(`/fixtures/headtohead?h2h=${team1Id}-${team2Id}&last=5`);
    return data.response || [];
  } catch (err) {
    console.error('[Football] fetchHeadToHead error:', err.response?.status, err.message);
    return [];
  }
}

// ── Signal analysis helpers ───────────────────────────────────────────────────

function calculateFormScore(fixtures, teamId) {
  let wins = 0, draws = 0, losses = 0;

  for (const fixture of fixtures) {
    const home = fixture.teams?.home;
    const away = fixture.teams?.away;
    const goals = fixture.goals;

    if (!home || !away || goals?.home == null || goals?.away == null) continue;

    const isHome = home.id === teamId;
    const teamGoals = isHome ? goals.home : goals.away;
    const oppGoals  = isHome ? goals.away : goals.home;

    if (teamGoals > oppGoals) wins++;
    else if (teamGoals === oppGoals) draws++;
    else losses++;
  }

  const total = wins + draws + losses;
  return { wins, draws, losses, winRate: total > 0 ? wins / total : 0 };
}

function averageGoals(fixtures) {
  if (!fixtures.length) return 0;
  const total = fixtures.reduce((sum, f) => sum + (f.goals?.home || 0) + (f.goals?.away || 0), 0);
  return total / fixtures.length;
}

// ── Signal generation ─────────────────────────────────────────────────────────

/**
 * Analyse a single fixture and return a signal object, or null if insufficient data.
 * Fetches form + H2H sequentially (not in parallel) to respect rate limits.
 */
async function analyseFixture(fixture, isLive = false) {
  const homeTeam = fixture.teams?.home;
  const awayTeam = fixture.teams?.away;
  if (!homeTeam || !awayTeam) return null;

  // Sequential fetches to avoid bursting the rate limit
  const homeForm = await fetchTeamForm(homeTeam.id);
  const awayForm = await fetchTeamForm(awayTeam.id);
  const h2h      = await fetchHeadToHead(homeTeam.id, awayTeam.id);

  const homeStats      = calculateFormScore(homeForm, homeTeam.id);
  const awayStats      = calculateFormScore(awayForm, awayTeam.id);
  const homeAvgGoals   = averageGoals(homeForm);
  const awayAvgGoals   = averageGoals(awayForm);
  const combinedAvgGoals = (homeAvgGoals + awayAvgGoals) / 2;

  const factors = [];
  let marketType = 'MATCH_WINNER';
  let side = 'YES';

  // Factor 1: Home team strong recent form (4+ of last 5 wins)
  if (homeStats.wins >= 4) {
    factors.push(`${homeTeam.name} won ${homeStats.wins}/5 recent matches`);
  }

  // Factor 2: Away team in poor form
  if (awayStats.wins <= 1 && awayStats.losses >= 3) {
    factors.push(`${awayTeam.name} poor form — ${awayStats.wins}W ${awayStats.losses}L last 5`);
  }

  // Factor 3: H2H home dominance (3+ wins in last 5 meetings)
  const h2hHomeWins = h2h.filter(f => {
    const isHome = f.teams?.home?.id === homeTeam.id;
    const g = f.goals;
    if (!g) return false;
    return isHome ? g.home > g.away : g.away > g.home;
  }).length;

  if (h2hHomeWins >= 3) {
    factors.push(`${homeTeam.name} won ${h2hHomeWins}/5 H2H meetings`);
  }

  // Factor 4: Live score momentum (leading by 2+ goals)
  let liveScore = null;
  if (isLive) {
    const score = fixture.goals;
    if (score?.home != null && score?.away != null) {
      liveScore = { home: score.home, away: score.away };
      if (liveScore.home > liveScore.away + 1) {
        factors.push(`${homeTeam.name} leading ${liveScore.home}–${liveScore.away} live`);
      } else if (liveScore.away > liveScore.home + 1) {
        factors.push(`${awayTeam.name} leading ${liveScore.away}–${liveScore.home} live`);
        side = 'NO'; // bet against home win
      }
    }
  }

  // Factor 5: High-scoring teams → lean OVER 2.5
  if (combinedAvgGoals > 2.8) {
    factors.push(`High-scoring fixture: avg ${combinedAvgGoals.toFixed(1)} goals/game`);
    marketType = 'OVER_2.5';
    side = 'YES';
  }

  // Require at least 1 factor to generate a signal (skip truly empty fixtures)
  if (factors.length === 0) return null;

  const confidence = factors.length >= 3 ? 'High' : factors.length === 2 ? 'Medium' : 'Low';

  const marketQuery = marketType === 'OVER_2.5'
    ? `${homeTeam.name} ${awayTeam.name} over goals`
    : `${homeTeam.name} win`;

  return {
    type: 'FOOTBALL',
    fixtureId: fixture.fixture?.id,
    marketQuery,
    homeTeam: homeTeam.name,
    awayTeam: awayTeam.name,
    side,
    marketType,
    confidence,
    factors,
    reasoning: factors.join('; '),
    timeframe: isLive ? '15min' : '1hr',
    isLive,
    liveScore,
  };
}

/**
 * Generate all football signals.
 * mode: 'live' | 'upcoming' | 'all'
 *
 * Limits fixtures processed to keep API call count manageable:
 *   - Live: up to 3 fixtures (3 × 3 calls = 9 calls)
 *   - Upcoming: up to 5 fixtures (5 × 3 calls = 15 calls)
 */
export async function generateFootballSignals(mode = 'all') {
  const signals = [];

  try {
    if (mode === 'live' || mode === 'all') {
      const liveMatches = await fetchLiveMatches();
      console.log(`[Football] Live matches found: ${liveMatches.length}`);

      for (const match of liveMatches.slice(0, 3)) {
        const signal = await analyseFixture(match, true);
        if (signal) signals.push(signal);
      }
    }

    if (mode === 'upcoming' || mode === 'all') {
      const upcoming = await fetchUpcomingFixtures();
      console.log(`[Football] Upcoming fixtures today: ${upcoming.length}`);

      // Only process Medium/High potential fixtures for upcoming — skip fixtures
      // with no data to avoid burning API quota on unanalysable games
      for (const match of upcoming.slice(0, 5)) {
        const signal = await analyseFixture(match, false);
        if (signal && signal.confidence !== 'Low') signals.push(signal);
      }
    }
  } catch (err) {
    console.error('[Football] generateFootballSignals error:', err.message);
  }

  return signals;
}
