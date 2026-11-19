
"use strict";

// Model defaults and assumptions aligned with the accompanying Colab notebook.
const MODEL = {
  returnDrift: [0.03, 0.09],
  returnVolatility: [0.12, 0.18],
  inflationVolatility: 0.02,
  transition: [[0.90, 0.10], [0.15, 0.85]],
  sensitivityContributions: [15000, 25000, 35000, 50000, 75000],
  sensitivityInflation: [0.02, 0.035, 0.05, 0.065]
};

let finalValues = [];
let running = false;
let paused = false;
let generation = 0;
let rng = null;
let distributionChart = null;
let sensitivityChart = null;
let runConfig = null;
let batchTimer = null;

// Aggregated regime observations from the latest main Monte Carlo run.
let marketStats = {
  regimeCounts: [0, 0],
  transitionCounts: [[0, 0], [0, 0]],
  totalObservations: 0
};

const $ = id => document.getElementById(id);
const money = x => "LKR " + Math.round(x).toLocaleString("en-US");
const pct = x => (100*x).toFixed(2) + "%";

// 1. Seeded random number generator
function createRandom(seed) {
  let value = seed >>> 0;

  return function() {
    value += 0x6D2B79F5;

    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2. Standard normal random number (Box-Muller)
function normalRandom(random) {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();

  return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
}

// 3. Read simulation parameters
function readConfig() {
  return {
    initial: Number($("initial").value),
    contribution: Number($("contribution").value),
    target: Number($("target").value),
    years: Number($("years").value),
    paths: Number($("paths").value),
    inflation: Number($("inflation").value)/100,
    seed: Math.max(1, Number($("seed").value)||42)
  };
}

// 4. Simulate one savings path
function simulateOne(c, random, regimeStats = null) {
  let balance = c.initial;
  let inflationFactor = 1;
  let regime = 0;

  // Every path starts in the Low-return regime.
  if (regimeStats) {
    regimeStats.regimeCounts[regime]++;
    regimeStats.totalObservations++;
  }

  for (let month=0; month<c.years*12; month++) {

    // Markov-chain market regime transition.
    if(month>0) {
      const previousRegime = regime;

      const nextRegime =
        random() < MODEL.transition[regime][1] ? 1 : 0;

      // Record the transition and new regime.
      if (regimeStats) {
        regimeStats.transitionCounts[previousRegime][nextRegime]++;
        regimeStats.regimeCounts[nextRegime]++;
        regimeStats.totalObservations++;
      }

      regime = nextRegime;
    }

    // Investment return using GBM
    const mu = MODEL.returnDrift[regime];
    const sigma = MODEL.returnVolatility[regime];

    const logR =
      (mu - 0.5*sigma*sigma)/12 +
      sigma/Math.sqrt(12)*normalRandom(random);

    // Inflation using GBM
    const logPi =
      (c.inflation - 0.5*MODEL.inflationVolatility**2)/12 +
      MODEL.inflationVolatility/Math.sqrt(12)*normalRandom(random);

    // Apply investment return
    balance *= Math.exp(logR);

    // End-of-month contribution
    balance += c.contribution;

    // Accumulate inflation
    inflationFactor *= Math.exp(logPi);
  }

  // Convert nominal savings into today's purchasing power
  return balance/inflationFactor;
}

// 5. Wilson confidence interval
function wilson(successes,total,z=1.96) {
  const p=successes/total;
  const den=1+z*z/total;

  const centre =
    (p+z*z/(2*total))/den;

  const half =
    z*Math.sqrt(
      p*(1-p)/total +
      z*z/(4*total*total)
    )/den;

  return [
    Math.max(0,centre-half),
    Math.min(1,centre+half)
  ];
}

// 6. Calculate quantiles
function quantile(sorted,q) {
  const pos=(sorted.length-1)*q;
  const lo=Math.floor(pos);
  const hi=Math.ceil(pos);

  return sorted[lo]+(sorted[hi]-sorted[lo])*(pos-lo);
}

// 7. Histogram generation
function histogram(values,bins=30) {
  if(!values.length) return {labels:[],counts:[]};

  const min=Math.min(...values);
  const max=Math.max(...values);
  const width=(max-min)/bins || 1;

  const counts=Array(bins).fill(0);
  const labels=[];

  for(let i=0;i<bins;i++) {
    labels.push(money(min+i*width));
  }

  for(const v of values) {
    counts[Math.min(bins-1,Math.floor((v-min)/width))]++;
  }

  return {labels,counts};
}

// 8. Initialize charts
function initCharts() {

  distributionChart = new Chart($("distributionChart"), {
    type:"bar",

    data:{
      labels:[],
      datasets:[{
        label:"Simulation paths",
        data:[],
        backgroundColor:"#4f7cff"
      }]
    },

    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:false,

      plugins:{
        legend:{display:true}
      },

      scales:{
        x:{
          ticks:{
            maxRotation:0,
            minRotation:0,
            autoSkip:true,
            maxTicksLimit:10
          },

          title:{
            display:true,
            text:"Final savings in today's purchasing power (LKR)"
          }
        },

        y:{
          beginAtZero:true,

          title:{
            display:true,
            text:"Number of paths"
          }
        }
      }
    }
  });

  sensitivityChart = new Chart($("sensitivityChart"), {
    type:"line",

    data:{
      labels:[],
      datasets:[]
    },

    options:{
      responsive:true,
      maintainAspectRatio:false,
      animation:false,

      plugins:{
        tooltip:{
          callbacks:{
            label:ctx=>`${ctx.dataset.label}: ${pct(ctx.parsed.y)}`
          }
        }
      },

      scales:{
        x:{
          title:{
            display:true,
            text:"Monthly contribution (LKR)"
          }
        },

        y:{
          beginAtZero:true,
          max:1,

          title:{
            display:true,
            text:"Probability of reaching target"
          }
        }
      }
    }
  });
}

// 9. Update observed market-regime statistics
function updateMarketRegimeStats() {

  const total = marketStats.totalObservations;

  if (!total) {
    $("observedLowFrequency").textContent = "—";
    $("observedHighFrequency").textContent = "—";

    $("observedLowToLow").textContent = "—";
    $("observedLowToHigh").textContent = "—";
    $("observedHighToLow").textContent = "—";
    $("observedHighToHigh").textContent = "—";

    $("marketRegimeStatus").textContent =
      "Run the main simulation to calculate observed market-regime statistics. Values are aggregated across all simulated paths and months.";

    return;
  }

  const low = marketStats.regimeCounts[0];
  const high = marketStats.regimeCounts[1];

  const transitionRows = marketStats.transitionCounts;

  const transitionText = (count, rowTotal) =>
    rowTotal
      ? `${pct(count / rowTotal)} (${count.toLocaleString("en-US")})`
      : "—";

  // Overall regime frequencies
  $("observedLowFrequency").textContent =
    pct(low / total);

  $("observedHighFrequency").textContent =
    pct(high / total);

  // Observed transition probabilities
  const lowRowTotal =
    transitionRows[0][0] + transitionRows[0][1];

  const highRowTotal =
    transitionRows[1][0] + transitionRows[1][1];

  $("observedLowToLow").textContent =
    transitionText(transitionRows[0][0], lowRowTotal);

  $("observedLowToHigh").textContent =
    transitionText(transitionRows[0][1], lowRowTotal);

  $("observedHighToLow").textContent =
    transitionText(transitionRows[1][0], highRowTotal);

  $("observedHighToHigh").textContent =
    transitionText(transitionRows[1][1], highRowTotal);

  $("marketRegimeStatus").textContent =
    `Observed across ${total.toLocaleString("en-US")} regime-month observations from ${finalValues.length.toLocaleString("en-US")} simulated paths. Transition cells show the observed percentage and transition count within each starting regime.`;
}

// 10. Update simulation results
function updateDistribution() {

  const n=finalValues.length;

  const total=runConfig
    ? runConfig.paths
    : Number($("paths").value);

  $("progress").textContent =
    (100*n/total).toFixed(1)+"%";

  $("pathsDone").textContent =
    n.toLocaleString("en-US");

  if(!n) {

    [
      "successProbability",
      "confidenceInterval",
      "meanSavings",
      "medianSavings"
    ].forEach(id=>$(id).textContent="—");

    distributionChart.data.labels=[];
    distributionChart.data.datasets[0].data=[];

    distributionChart.update("none");

    $("interpretation").textContent =
      "Run the simulation to receive a summary of the estimated probability of reaching the target and the final real-savings distribution.";

    return;
  }

  const successes=finalValues.filter(
    v=>v>=runConfig.target
  ).length;

  const p=successes/n;
  const ci=wilson(successes,n);

  const mean=finalValues.reduce((a,b)=>a+b,0)/n;

  const sorted=[...finalValues].sort((a,b)=>a-b);

  const median=quantile(sorted,.5);

  $("successProbability").textContent=pct(p);

  $("confidenceInterval").textContent =
    `${pct(ci[0])} – ${pct(ci[1])}`;

  $("meanSavings").textContent=money(mean);
  $("medianSavings").textContent=money(median);

  const h=histogram(finalValues);

  distributionChart.data.labels=h.labels;
  distributionChart.data.datasets[0].data=h.counts;

  distributionChart.update("none");

  $("interpretation").textContent =
    `${successes.toLocaleString("en-US")} of ${n.toLocaleString("en-US")} simulated paths reached the target. The estimated probability is ${pct(p)}, with a 95% Wilson interval from ${pct(ci[0])} to ${pct(ci[1])}. Mean final real savings are ${money(mean)} and median final real savings are ${money(median)}. These results are conditional on the selected illustrative assumptions.`;
}

// 11. Update parameter labels
function updateLabels() {

  $("initialValue").textContent =
    money(+$("initial").value);

  $("contributionValue").textContent =
    money(+$("contribution").value);

  $("targetValue").textContent =
    money(+$("target").value);

  $("yearsValue").textContent =
    $("years").value+" years";

  $("pathsValue").textContent =
    (+$("paths").value).toLocaleString("en-US");

  $("inflationValue").textContent =
    (+$("inflation").value).toFixed(1)+"%";
}

// 12. Stop pending simulation batch
function stopTimer() {

  if(batchTimer!==null) {
    clearTimeout(batchTimer);
    batchTimer=null;
  }
}

// 13. Run simulation in batches
function runBatch(token) {

  if(token!==generation || !running || paused) return;

  const batch=100;

  for(
    let i=0;
    i<batch && finalValues.length<runConfig.paths;
    i++
  ) {
    finalValues.push(
      simulateOne(runConfig,rng,marketStats)
    );
  }

  updateDistribution();
  updateMarketRegimeStats();

  if(finalValues.length<runConfig.paths) {

    batchTimer=setTimeout(
      ()=>runBatch(token),
      0
    );

  } else {

    running=false;

    stopTimer();

    $("startButton").textContent="Start";
    $("status").textContent="Simulation completed.";
  }
}

// 14. Reset simulation
function resetSimulation() {

  generation++;

  stopTimer();

  running=false;
  paused=false;

  finalValues=[];
  runConfig=null;
  rng=null;

  // Clear previous market-regime observations.
  marketStats = {
    regimeCounts: [0, 0],
    transitionCounts: [[0, 0], [0, 0]],
    totalObservations: 0
  };

  updateMarketRegimeStats();

  $("startButton").textContent="Start";
  $("pauseButton").textContent="Pause";

  $("status").textContent =
    "Reset complete. Ready for a new simulation.";

  updateDistribution();
}

// 15. Start simulation
$("startButton").addEventListener("click",()=>{

  if(running) return;

  if(finalValues.length && runConfig) {

    if(finalValues.length>=runConfig.paths) {
      resetSimulation();

    } else if(!paused) {
      return;
    }
  }

  if(!runConfig) {
    runConfig=readConfig();
    rng=createRandom(runConfig.seed);
  }

  running=true;
  paused=false;

  $("startButton").textContent="Running...";
  $("pauseButton").textContent="Pause";

  $("status").textContent="Simulation running...";

  const token=generation;

  runBatch(token);
});

// 16. Pause and Resume
$("pauseButton").addEventListener("click",()=>{

  if(!running && !paused) return;

  if(running) {

    paused=true;
    running=false;

    stopTimer();

    $("pauseButton").textContent="Resume";

    $("status").textContent =
      "Paused. Press Resume to continue.";

  } else if(paused) {

    paused=false;
    running=true;

    $("pauseButton").textContent="Pause";

    $("status").textContent =
      "Simulation resumed.";

    runBatch(generation);
  }
});

// 17. Reset button
$("resetButton").addEventListener(
  "click",
  resetSimulation
);

// 18. Parameter change handlers
[
  "initial",
  "contribution",
  "target",
  "years",
  "paths",
  "inflation"
].forEach(id=>{

  $(id).addEventListener("input",()=>{

    updateLabels();

    if(finalValues.length || running || paused) {
      resetSimulation();
    }
  });
});

$("seed").addEventListener("change",()=>{

  if(finalValues.length || running || paused) {
    resetSimulation();
  }
});

// 19. Validate custom sensitivity inputs
function parseSensitivityValues(
  raw,
  label,
  maxCount,
  minValue,
  maxValue
) {

  const values=raw
    .split(",")
    .map(x=>x.trim())
    .filter(Boolean)
    .map(Number);

  if(
    values.length<1 ||
    values.length>maxCount ||
    values.some(x=>
      !Number.isFinite(x) ||
      x<minValue ||
      x>maxValue
    )
  ) {

    throw new Error(
      `${label}: enter 1–${maxCount} valid numbers between ${minValue} and ${maxValue}.`
    );
  }

  return [...new Set(values)];
}

// 20. Update Section 3 base settings
function updateSensitivityBaseSettings() {
  const config = readConfig();

  $("sensitivityInitial").textContent = money(config.initial);
  $("sensitivityTarget").textContent = money(config.target);
  $("sensitivityYears").textContent = config.years + " years";
}

// 21. Run sensitivity analysis
$("sensitivityButton").addEventListener("click", () => {

  if (running || paused) {
    $("sensitivityStatus").textContent =
      "Pause or reset the main simulation first.";
    return;
  }

  let contributions;
  let inflationRates;

  try {
    contributions = parseSensitivityValues(
      $("customContributions").value,
      "Monthly contributions",
      5,
      0,
      10000000
    );

    inflationRates = parseSensitivityValues(
      $("customInflations").value,
      "Annual inflation rates (%)",
      5,
      0,
      20
    ).map(value => value / 100);

  } catch (error) {
    $("sensitivityStatus").textContent = error.message;
    return;
  }

  // Reuse Section 1 settings.
  // Only contribution and inflation are varied.
  const base = readConfig();

  const pathsPerScenario = 10000;
  const rows = [];

  const scenarioCount =
    contributions.length * inflationRates.length;

  $("sensitivityButton").disabled = true;

  $("sensitivityStatus").textContent =
    `Calculating ${scenarioCount} scenarios × ${pathsPerScenario.toLocaleString("en-US")} paths...`;

  setTimeout(() => {

    try {
      const datasets = [];

      for (const inflation of inflationRates) {

        const probabilities = [];

        for (const contribution of contributions) {

          const config = {
            ...base,
            contribution,
            inflation,
            paths: pathsPerScenario
          };

          // Reproducible random stream for each scenario.
          const random = createRandom(base.seed);

          const values = Array.from(
            { length: pathsPerScenario },
            () => simulateOne(config, random)
          );

          const successes = values.filter(
            value => value >= config.target
          ).length;

          const interval = wilson(
            successes,
            pathsPerScenario
          );

          values.sort((a, b) => a - b);

          rows.push({
            contribution,
            inflation,
            probability: successes / pathsPerScenario,
            lower: interval[0],
            upper: interval[1],
            median: quantile(values, 0.5)
          });

          probabilities.push(successes / pathsPerScenario);
        }

        datasets.push({
          label: `Inflation ${(inflation * 100).toFixed(1)}%`,
          data: probabilities,
          borderWidth: 2,
          tension: 0.15
        });
      }

      // Update comparison chart.
      sensitivityChart.data.labels =
        contributions.map(money);

      sensitivityChart.data.datasets = datasets;
      sensitivityChart.update();

      // Update results table.
      $("sensitivityTable").querySelector("tbody").innerHTML =
        rows.map(row => `
          <tr>
            <td>${money(row.contribution)}</td>
            <td>${(row.inflation * 100).toFixed(1)}%</td>
            <td>${pct(row.probability)}</td>
            <td>${pct(row.lower)} – ${pct(row.upper)}</td>
            <td>${money(row.median)}</td>
          </tr>
        `).join("");

      // Find the scenario with the highest success probability.
      const best = [...rows].sort(
        (a, b) => b.probability - a.probability
      )[0];

      $("sensitivityBest").textContent =
        `${money(best.contribution)} monthly contribution | ` +
        `${(best.inflation * 100).toFixed(1)}% inflation | ` +
        `${pct(best.probability)} success probability`;

      $("sensitivityStatus").textContent =
        `Completed: ${scenarioCount} scenarios × ${pathsPerScenario.toLocaleString("en-US")} paths (${(scenarioCount * pathsPerScenario).toLocaleString("en-US")} total paths).`;

    } catch (error) {
      console.error(error);

      $("sensitivityStatus").textContent =
        "Sensitivity analysis failed. Check the browser console.";

    } finally {
      $("sensitivityButton").disabled = false;
    }

  }, 50);
});

// 22. Synchronize Section 3 with Section 1.
["initial", "target", "years"].forEach(id => {
  $(id).addEventListener("input", updateSensitivityBaseSettings);
});

// 23. Initial setup
updateLabels();
initCharts();
updateDistribution();
updateMarketRegimeStats();
updateSensitivityBaseSettings();
