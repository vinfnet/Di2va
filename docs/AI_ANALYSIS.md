# Di2va — AI Shifting Analysis

The AI Shifting Analysis feature scores your gear-shifting quality across your most recent rides and suggests where you could improve. It analyses cadence, terrain, cross-chaining, and shift behaviour using established cycling best-practices — no external AI service or LLM is involved; the "AI" is a deterministic rules engine running entirely on your machine.

![AI Shifting Analysis results](screenshots/di2va-ai-analysis.png)

*AI Shifting Analysis results — star rating, component breakdown bars, per-ride scoring table, and text summary with specific feedback.*

---

## How It Works

### 1. Data Collection

When you click the **AI Analysis** button on the activities screen, Di2va:

1. Calls the Strava API to fetch your **10 most recent cycling activities**
2. For each ride, downloads the activity streams (GPS, elevation, cadence, speed, power, gradient)
3. **Estimates gears** from cadence + speed using the standard gear ratio formula:

$$\text{gear\_ratio} = \frac{\text{speed (m/s)}}{\frac{\text{cadence (RPM)}}{60} \times \text{wheel circumference (m)}}$$

4. Matches the calculated ratio against all possible chainring/cassette combinations to determine which gear you were most likely in at each data point

**Assumed gearing** (Shimano Dura-Ace R9200-style):
- Chainrings: 34/50 (compact double)
- Cassette: 11-12-13-14-15-17-19-21-23-25-28 (11-speed)
- Wheel circumference: 2.105 m (700×25c)

### 2. Scoring Engine

Each ride is scored 0–100% on four metrics, then combined with weights to produce an overall score mapped to a 1–5 star rating.

| Component | Weight | What It Measures |
|---|---|---|
| **Cadence Efficiency** | 30% | How much time you spend in the optimal 80–100 RPM zone |
| **Gradient Matching** | 25% | Whether your gear selection matches the terrain (easier gears on climbs, harder on flats/descents) |
| **Cross-Chain Avoidance** | 15% | Penalises big-chainring + big-cog and small-chainring + small-cog combinations |
| **Shift Smoothness** | 15% | Rewards single-gear shifts; penalises rapid back-and-forth "gear hunting" |
| **Anticipatory Bonus** | 15% | Derived from cadence + gradient scores — rewards shifting *before* a gradient change |

#### Overall formula

$$\text{overall} = 0.30 \times \text{cadence} + 0.25 \times \text{gradient} + 0.15 \times \text{crossChain} + 0.15 \times \text{smoothness} + 0.15 \times \frac{\text{cadence} + \text{gradient}}{2}$$

The result maps to stars: $\text{rating} = \text{clamp}(\text{round}(\text{overall} \times 5),\ 1,\ 5)$

---

## Scoring Detail

### Cadence Efficiency (30%)

For each data point where cadence > 0 and speed > 0.5 m/s:

| Cadence Range | Score |
|---|---|
| 80–100 RPM | 1.0 (perfect) |
| 70–110 RPM | 0.6 (acceptable) |
| 60–120 RPM | 0.3 (poor) |
| Outside 60–120 | 0.0 (very poor) |

**Why it matters:** Maintaining 80–100 RPM is widely recommended for efficient power delivery and reduced knee strain. Grinding at low cadence wastes energy; spinning too fast reduces pedalling effectiveness.

### Gradient Matching (25%)

At each point, the engine calculates the *optimal gear* for the current speed and gradient, then compares it to your actual gear:

| Gear Ratio Difference | Score |
|---|---|
| < 0.2 | 1.0 (spot on) |
| < 0.5 | 0.6 (close) |
| < 1.0 | 0.3 (off) |
| ≥ 1.0 | 0.0 (wrong gear) |

The optimal gear is selected using a **gradient-adjusted target cadence**:

| Gradient | Target Cadence | Rationale |
|---|---|---|
| > 8% (steep climb) | 75 RPM | Lower cadence acceptable on steep terrain |
| > 5% (climb) | 80 RPM | Moderate climbing cadence |
| > 2% (false flat / gentle rise) | 85 RPM | Slightly below flat-road target |
| −2% to +2% (flat) | 90 RPM | Standard flat-road cadence |
| −5% to −2% (gentle descent) | 92 RPM | Slightly higher on descents |
| < −5% (steep descent) | 95 RPM | Higher cadence to maintain control |

The target cadence values are based on widely-published cycling coaching guidance — see [References](#references) below.

### Cross-Chain Avoidance (15%)

Cross-chaining occurs when you use extreme gear combinations that put the chain at a harsh diagonal angle:

- **Big-big**: Big chainring (50T) + 3 largest cogs (25, 23, 21)
- **Small-small**: Small chainring (34T) + 3 smallest cogs (11, 12, 13)

The score is simply:

$$\text{crossChainScore} = 1 - \frac{\text{cross-chained points}}{\text{total gear points}}$$

**Why it matters:** Cross-chaining increases drivetrain wear, reduces power transfer efficiency, and causes chain noise. Modern drivetrains tolerate it better than older ones, but it's still best avoided.

### Shift Smoothness (15%)

Detects "gear hunting" — rapidly shifting back and forth, which indicates indecision or poor gear anticipation. For each shift event, the engine counts how many shifts occurred in a 15-second window:

- If > 3 shifts in 15 seconds → hunting penalty applied

$$\text{smoothnessScore} = \max\left(0,\ 1 - \frac{\text{huntingPenalties}}{\text{totalPoints} \times 0.05}\right)$$

**Why it matters:** Frequent back-and-forth shifting disrupts your pedalling rhythm and wastes energy. Smooth, decisive shifts indicate good terrain reading.

---

## Optimal Gear Overlay

When viewing a single ride, toggle **"Show optimal gear"** on the elevation profile to overlay a **dashed gold line** showing the recommended gear ratio at every point.

This uses the same `optimalGearForConditions()` engine as the scoring — for each data point it picks the gear combo from the full gear table whose ratio best matches the gradient-adjusted target cadence, with a penalty for cross-chained combos.

The overlay lets you visually compare your actual gear choices against the recommendation and spot where you were over- or under-geared.

---

## Where Data Goes

| What | Source | Destination | Stored? |
|---|---|---|---|
| Activity list (last 10 rides) | Strava API | Processed in Node.js on your machine | No — held in memory during analysis only |
| Activity streams (GPS, cadence, power, elevation, speed, gradient) | Strava API | Processed in Node.js on your machine | No — held in memory during analysis only |
| Estimated gear data | Computed locally from cadence + speed | Processed in Node.js on your machine | No — held in memory during analysis only |
| Scoring results (star rating, components, text) | Computed locally | Sent to your browser for display | No — not persisted anywhere |
| Optimal gear overlay data | Computed locally | Sent to your browser for chart display | No — not persisted anywhere |

**Nothing is stored on disk.** The analysis is computed fresh each time you click the button. No data is sent to any third-party service — the only network traffic is between your machine and Strava's API (which you already authorised).

---

## API Endpoints

### `GET /api/ai-analysis`

Fetches last 10 rides from Strava, estimates gears, scores each ride, and returns aggregate results.

**Response:**
```json
{
  "rating": 3,
  "overallPercent": "55",
  "summary": "Shifting Analysis — ★★★☆☆ (3/5)\nBased on your last 10 rides:\n\n...",
  "components": {
    "cadence": "57",
    "crossChain": "83",
    "gradient": "66",
    "hunting": "0"
  },
  "activities": [
    { "id": 123, "name": "Morning Ride", "date": "2026-03-13T07:00:00Z", "rating": 2, "overall": "44" }
  ],
  "analysedCount": 10
}
```

### `POST /api/optimal-gears`

Returns per-point optimal gear for the currently viewed activity.

**Request body:**
```json
{
  "cadence": [85, 86, 84, ...],
  "velocity_smooth": [8.2, 8.3, 8.1, ...],
  "grade_smooth": [2.1, 2.3, 3.0, ...],
  "distance": [0, 10, 20, ...]
}
```

**Response:**
```json
{
  "optimalGears": [
    { "front": 34, "rear": 19 },
    { "front": 34, "rear": 19 },
    null,
    ...
  ]
}
```

---

## References

The scoring thresholds and target cadences are based on established cycling guidance:

- **Optimal cadence 80–100 RPM**: Widely cited in cycling physiology literature. Higher cadences (85–95) reduce muscular fatigue at submaximal power, while lower cadences (70–80) may suit some climbers. See: Lucia, A. et al. (2004) *"Preferred pedalling cadence in professional cycling"*, Medicine & Science in Sports & Exercise.
- **Gradient-adjusted cadence**: Professional cyclists typically lower cadence to 70–80 RPM on steep climbs and increase to 90–100 RPM on flats/descents. Source: Coggan, A. & Allen, H., *Training and Racing with a Power Meter* (VeloPress).
- **Cross-chain avoidance**: Shimano's own drivetrain guides recommend avoiding extreme chain angles. While modern 11/12-speed drivetrains are more tolerant, cross-chaining still increases wear and noise.
- **Anticipatory shifting**: Shifting *before* a gradient change (e.g., clicking into an easier gear as you approach a hill rather than grinding halfway up) is a fundamental skill taught in cycling coaching courses.

---

## Limitations

- **Gear estimation only** — without a FIT file, gears are estimated from cadence × speed. This can be inaccurate at low speeds, during coasting, or when cadence data drops out.
- **Fixed gearing assumed** — the analysis assumes a 34/50 × 11-28 setup. If your bike has different gearing, the optimal gear recommendations will be off.
- **No power-based analysis** — power data is available from Strava but not yet integrated into the scoring engine. A future version could weight gear choices by power zone.
- **10-ride window** — the analysis only looks at your 10 most recent rides. A longer window would give more statistically meaningful results.
- **No terrain type detection** — the engine doesn't distinguish between road types (e.g., smooth tarmac vs rough gravel) which can affect optimal gearing.
