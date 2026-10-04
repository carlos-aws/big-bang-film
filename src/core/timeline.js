// The single source of truth for when things happen. All times are seconds of film time (T),
// measured from the click on "So it begins..".
(function () {
  'use strict';
  const U = window.U;

  // Scenes overlap their neighbours; inside an overlap the engine cross-fades from the
  // earlier scene to the later one (smoothstep over the overlap window).
  const scenes = [
    { id: 'bigbang', start: 0, end: 17 },
    { id: 'plasma', start: 15, end: 32 },
    { id: 'cosmicdawn', start: 30, end: 47 },
    { id: 'cosmicweb', start: 45, end: 62 },
    { id: 'milkyway', start: 60, end: 77 },
    { id: 'solarsystem', start: 75, end: 95 },
    { id: 'theia', start: 93, end: 110 },
    { id: 'earth', start: 108, end: 190 },
  ];

  // Key moments. Visuals and the score both sync to these.
  const cues = {
    spark: 1.6, // a single point of light appears in the void
    bang: 5.0, // the Big Bang
    inflationEnd: 8.0, // runaway expansion settles into the fireball
    recombination: 25.0, // the fog clears: first light (CMB)
    firstStar: 35.0, // the first star ignites
    firstSupernova: 40.5, // a first-generation star explodes
    webReveal: 49.0, // pull-back reveals the cosmic web
    galaxyMerger: 54.5, // two galaxies collide
    solarSupernova: 70.0, // the supernova whose shockwave seeds the solar nebula
    sunIgnition: 80.0, // the Sun ignites
    earthFormed: 89.0, // proto-Earth emerges from the disk
    theiaImpact: 99.0, // Theia strikes the proto-Earth
    moonFormed: 105.0, // the Moon has coalesced
    oceans: 115.0, // the rains begin, oceans form
    life: 122.0, // life tints the oceans
    oxygenation: 127.0, // great oxygenation
    rodinia: 131.0, // first supercontinent (Rodinia)
    snowball: 133.0, // Snowball Earth freezes over
    thaw: 137.0, // the ice retreats
    pangaea: 150.0, // Pangaea fully assembled
    breakup: 156.0, // Pangaea begins to rift
    dinosaursEnd: 165.0, // ~66 Ma
    today: 174.0, // the present day is reached
    outroStart: 184.0, // final fade to black begins
  };

  const duration = 190.0; // when the fade completes and the intro text returns

  // Years-ago keyframes: [T, yearsAgo, easing of the segment that ends at this key]
  //   'lin' linear, 'log' log-space (constant ratio per second), 'in' slow start (cubic),
  //   'out' decelerating arrival.
  const yearsKeys = [
    [0, 13.8e9],
    [cues.bang, 13.8e9, 'lin'],
    [cues.inflationEnd, 13.8e9, 'lin'], // inflation is over within a fraction of a second
    [cues.recombination, 13.79962e9, 'in'], // 380,000 years after the Big Bang
    [31.0, 13.7e9, 'lin'], // the dark ages
    [cues.firstStar, 13.6e9, 'lin'], // first stars ~200 Myr after
    [47.0, 13.2e9, 'lin'], // first galaxies
    [62.0, 9.0e9, 'lin'], // galaxies assemble, Milky Way disk forms
    [cues.solarSupernova, 4.6e9, 'lin'],
    [cues.sunIgnition, 4.567e9, 'lin'],
    [95.0, 4.54e9, 'lin'], // Earth accreted
    [cues.theiaImpact, 4.51e9, 'lin'],
    [110.0, 4.45e9, 'lin'],
    [cues.oceans, 4.3e9, 'lin'],
    [cues.life, 3.5e9, 'lin'],
    [cues.oxygenation, 2.4e9, 'lin'],
    [cues.rodinia, 1.0e9, 'log'],
    [cues.snowball, 720e6, 'lin'],
    [cues.thaw, 635e6, 'lin'],
    [cues.pangaea, 320e6, 'log'],
    [cues.breakup, 200e6, 'lin'],
    [cues.today, 0, 'out'],
  ];

  function yearsAgo(T) {
    const k = yearsKeys;
    if (T <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (T <= k[i][0]) {
        const a = k[i - 1][1], b = k[i][1];
        const u = (T - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
        switch (k[i][2]) {
          case 'log': return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u);
          case 'in': return a + (b - a) * u * u * u;
          case 'out': return b + (a - b) * Math.pow(1 - u, 1.6);
          default: return a + (b - a) * u;
        }
      }
    }
    return k[k.length - 1][1];
  }

  // Inverse of yearsAgo (monotone): the film time at which `years` is reached.
  function timeOfYears(years) {
    let lo = 0, hi = cues.today;
    if (years >= 13.8e9) return cues.bang;
    if (years <= 0) return cues.today;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (yearsAgo(mid) > years) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  U.timeline = { scenes, cues, duration, yearsKeys, yearsAgo, timeOfYears };
})();
