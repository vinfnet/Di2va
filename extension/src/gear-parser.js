/**
 * Di2va — FIT Gear Data Parser
 *
 * Extracts Di2 gear shift events and per-record gear data from parsed FIT data.
 * Pure JS — no dependencies on Node.js APIs.
 */

/**
 * Decode gear data packed in a FIT event's uint32 `data` field.
 * Layout: byte0 = rear_gear_num, byte1 = rear_gear_teeth,
 *         byte2 = front_gear_num, byte3 = front_gear_teeth
 */
export function decodeGearData(data) {
  if (typeof data !== 'number' || data === 0) return null;
  return {
    rear_gear_num:    data & 0xFF,
    rear_gear_teeth:  (data >> 8) & 0xFF,
    front_gear_num:   (data >> 16) & 0xFF,
    front_gear_teeth: (data >> 24) & 0xFF
  };
}

function normaliseGearNum(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  // FIT invalid sentinel for uint8 fields is often 255.
  if (n <= 0 || n >= 255) return null;
  return n;
}

function normaliseTeeth(value, type) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const t = Math.trunc(value);
  // FIT invalid sentinel for uint8 fields is often 255.
  if (t <= 0 || t >= 255) return null;

  // Keep broad but realistic guardrails.
  if (type === 'front') {
    return (t >= 20 && t <= 70) ? t : null;
  }
  return (t >= 9 && t <= 60) ? t : null;
}

function hasAllValues(set, values) {
  return values.every(v => set.has(v));
}

function applyGearSignatureScores(scores, setup) {
  const front = setup?.front_chainrings || [];
  const rear = setup?.rear_cogs || [];
  if (!front.length || !rear.length) return;

  const frontSet = new Set(front);
  const rearSet = new Set(rear);
  const minRear = Math.min(...rear);
  const maxRear = Math.max(...rear);

  // Very strong SRAM indicator for modern AXS road/gravel setups.
  if (minRear <= 10) {
    scores.sram += 8;
  }

  // Common Shimano 12s road cassette signature: 11-34 with 24/27/30 jumps.
  const shimano12Road34 = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34];
  if (rear.length === shimano12Road34.length && hasAllValues(rearSet, shimano12Road34)) {
    scores.shimano += 10;
  }

  // Common SRAM road compact pairing.
  if (frontSet.has(48) && frontSet.has(35)) {
    scores.sram += 4;
  }

  // Common Shimano compact pairing.
  if (frontSet.has(50) && frontSet.has(34) && minRear >= 11) {
    scores.shimano += 4;
  }

  // EPS often runs 11T+ road cassettes with broader top-end than old Shimano.
  if (minRear >= 11 && maxRear >= 29 && front.length >= 2) {
    scores.campagnolo += 1;
  }

  // If we have plausible electronic multi-gear setup but no vendor markers.
  if (rear.length >= 8 && front.length >= 1) {
    scores.electronic += 1;
  }
}

function detectGroupset(deviceInfo, gearChanges) {
  const candidates = {
    shimano: {
      vendor: 'shimano',
      family: 'di2',
      label: 'Shimano Di2',
      manufacturerIds: [41],
      keywords: ['shimano', 'di2', 'dura-ace', 'ultegra', '105 di2']
    },
    sram: {
      vendor: 'sram',
      family: 'axs',
      label: 'SRAM AXS',
      manufacturerIds: [],
      keywords: ['sram', 'axs', 'red etap', 'force etap', 'rival etap']
    },
    campagnolo: {
      vendor: 'campagnolo',
      family: 'eps',
      label: 'Campagnolo EPS',
      manufacturerIds: [],
      keywords: ['campagnolo', 'eps', 'super record', 'record eps']
    },
    fsa: {
      vendor: 'fsa',
      family: 'we',
      label: 'FSA WE',
      manufacturerIds: [],
      keywords: ['fsa', 'fsa we', 'k-force we']
    }
  };

  const scores = {
    shimano: 0,
    sram: 0,
    campagnolo: 0,
    fsa: 0,
    electronic: 0
  };

  for (const d of deviceInfo) {
    const manufacturerRaw = d.manufacturer;
    const manufacturer = (d.manufacturer || '').toString().toLowerCase();
    const productName = (d.product_name || '').toString().toLowerCase();
    const deviceName = (d.device_name || '').toString().toLowerCase();
    const blob = `${manufacturer} ${productName} ${deviceName}`;

    for (const key of Object.keys(candidates)) {
      const candidate = candidates[key];

      if (candidate.manufacturerIds.includes(manufacturerRaw)) {
        scores[key] += 5;
      }
      if (blob.includes(candidate.vendor)) {
        scores[key] += 4;
      }

      for (const kw of candidate.keywords) {
        if (kw && blob.includes(kw)) scores[key] += 2;
      }
    }

    if (blob.includes('electronic') || blob.includes('eshift') || blob.includes('e-shift')) {
      scores.electronic += 2;
    }
  }

  const frontSet = new Set();
  const rearSet = new Set();
  for (const gc of gearChanges) {
    if (gc.front_gear_teeth) frontSet.add(gc.front_gear_teeth);
    if (gc.rear_gear_teeth) rearSet.add(gc.rear_gear_teeth);
  }

  const setup = {
    front_chainrings: [...frontSet].sort((a, b) => a - b),
    rear_cogs: [...rearSet].sort((a, b) => a - b),
    drivetrain: frontSet.size && rearSet.size ? `${frontSet.size}x${rearSet.size}` : null
  };

  // Fallback scoring from observed gearing when vendor metadata is sparse/missing.
  applyGearSignatureScores(scores, setup);

  const ranked = Object.entries(scores)
    .sort((a, b) => b[1] - a[1]);
  const [bestKey, bestScore] = ranked[0] || ['unknown', 0];

  if (!bestScore) {
    return {
      vendor: 'unknown',
      family: null,
      label: 'Unknown groupset',
      setup
    };
  }

  if (bestKey === 'electronic') {
    return {
      vendor: 'electronic',
      family: null,
      label: 'Electronic groupset',
      setup
    };
  }

  if (candidates[bestKey]) {
    return {
      vendor: candidates[bestKey].vendor,
      family: candidates[bestKey].family,
      label: candidates[bestKey].label,
      setup
    };
  }

  return {
    vendor: 'unknown',
    family: null,
    label: 'Unknown groupset',
    setup
  };
}

/**
 * Extract Di2 gear shift data from parsed FIT file.
 * Handles rear_gear_change / front_gear_change events (Garmin)
 * and the older gear_change event type.
 *
 * @param {object} fitData — parsed FIT data from fit-file-parser
 * @returns {{ gear_changes: Array, records: Array, di2_devices: Array, session: object|null, has_gear_data: boolean }}
 */
export function extractDi2Data(fitData) {
  const gearChanges = [];
  const records = [];

  // Extract gear change events
  if (fitData.events) {
    fitData.events.forEach(event => {
      const isGearEvent =
        event.event === 'rear_gear_change' ||
        event.event === 'front_gear_change' ||
        event.event === 'gear_change' ||
        event.event_type === 'gear_change';

      if (!isGearEvent) return;

      let rearNum   = event.rear_gear_num;
      let rearTeeth = event.rear_gear_teeth;
      let frontNum  = event.front_gear_num;
      let frontTeeth = event.front_gear_teeth;

      if (rearTeeth === undefined && event.data !== undefined) {
        const decoded = decodeGearData(event.data);
        if (decoded) {
          rearNum   = decoded.rear_gear_num;
          rearTeeth = decoded.rear_gear_teeth;
          frontNum  = decoded.front_gear_num;
          frontTeeth = decoded.front_gear_teeth;
        }
      }

      rearNum = normaliseGearNum(rearNum);
      frontNum = normaliseGearNum(frontNum);
      rearTeeth = normaliseTeeth(rearTeeth, 'rear');
      frontTeeth = normaliseTeeth(frontTeeth, 'front');

      gearChanges.push({
        timestamp: event.timestamp,
        event_type: event.event,
        rear_gear_num:    rearNum   || null,
        rear_gear_teeth:  rearTeeth || null,
        front_gear_num:   frontNum  || null,
        front_gear_teeth: frontTeeth || null,
        gear_ratio: (frontTeeth && rearTeeth) ? +(frontTeeth / rearTeeth).toFixed(2) : null
      });
    });
  }

  gearChanges.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Extract per-record data
  if (fitData.records) {
    fitData.records.forEach(record => {
      const rec = {
        timestamp: record.timestamp,
        elapsed_time: record.elapsed_time,
        distance: record.distance,
        position_lat: record.position_lat,
        position_long: record.position_long,
        altitude: record.altitude || record.enhanced_altitude,
        speed: record.speed || record.enhanced_speed,
        cadence: record.cadence,
        power: record.power,
        heart_rate: record.heart_rate,
        temperature: record.temperature
      };

      if (record.rear_gear_num !== undefined) rec.rear_gear_num = record.rear_gear_num;
      if (record.rear_gear_teeth !== undefined) rec.rear_gear_teeth = record.rear_gear_teeth;
      if (record.front_gear_num !== undefined) rec.front_gear_num = record.front_gear_num;
      if (record.front_gear_teeth !== undefined) rec.front_gear_teeth = record.front_gear_teeth;
      if (record.left_right_balance !== undefined) rec.left_right_balance = record.left_right_balance;

      rec.rear_gear_num = normaliseGearNum(rec.rear_gear_num);
      rec.front_gear_num = normaliseGearNum(rec.front_gear_num);
      rec.rear_gear_teeth = normaliseTeeth(rec.rear_gear_teeth, 'rear');
      rec.front_gear_teeth = normaliseTeeth(rec.front_gear_teeth, 'front');

      records.push(rec);
    });
  }

  // Merge gear change events into records by timestamp
  if (gearChanges.length > 0 && records.length > 0) {
    let gearIdx = 0;
    let currentGear = {
      front_gear_num:   gearChanges[0].front_gear_num,
      front_gear_teeth: gearChanges[0].front_gear_teeth,
      rear_gear_num:    gearChanges[0].rear_gear_num,
      rear_gear_teeth:  gearChanges[0].rear_gear_teeth
    };

    records.forEach(record => {
      while (gearIdx < gearChanges.length &&
             new Date(gearChanges[gearIdx].timestamp) <= new Date(record.timestamp)) {
        const gc = gearChanges[gearIdx];
        if (gc.front_gear_num)   currentGear.front_gear_num   = gc.front_gear_num;
        if (gc.front_gear_teeth) currentGear.front_gear_teeth = gc.front_gear_teeth;
        if (gc.rear_gear_num)    currentGear.rear_gear_num    = gc.rear_gear_num;
        if (gc.rear_gear_teeth)  currentGear.rear_gear_teeth  = gc.rear_gear_teeth;
        gearIdx++;
      }

      // Always apply event-based gear tracking — many devices (e.g. Garmin Edge)
      // write a static initial gear into every record and rely on events for changes.
      record.rear_gear_num    = currentGear.rear_gear_num;
      record.rear_gear_teeth  = currentGear.rear_gear_teeth;
      record.front_gear_num   = currentGear.front_gear_num;
      record.front_gear_teeth = currentGear.front_gear_teeth;

      if (record.front_gear_teeth && record.rear_gear_teeth) {
        record.gear_ratio = +(record.front_gear_teeth / record.rear_gear_teeth).toFixed(2);
      }
    });
  }

  // Detect Di2 devices
  const SHIMANO_MFR_IDS = [41, 'shimano'];
  const deviceInfo = fitData.device_infos || [];
  const di2Devices = deviceInfo.filter(d =>
    SHIMANO_MFR_IDS.includes(d.manufacturer) ||
    (d.product_name && d.product_name.toLowerCase().includes('di2')) ||
    (d.product_name && d.product_name.toLowerCase().includes('shimano'))
  );
  const sramDevices = deviceInfo.filter(d =>
    (d.manufacturer || '').toString().toLowerCase() === 'sram' ||
    (d.product_name && d.product_name.toLowerCase().includes('sram')) ||
    (d.product_name && d.product_name.toLowerCase().includes('axs'))
  );
  const campagnoloDevices = deviceInfo.filter(d =>
    (d.manufacturer || '').toString().toLowerCase() === 'campagnolo' ||
    (d.product_name && d.product_name.toLowerCase().includes('campagnolo')) ||
    (d.product_name && d.product_name.toLowerCase().includes('eps'))
  );

  const groupset = detectGroupset(deviceInfo, gearChanges);

  const hasGearData = gearChanges.length > 0 ||
                      records.some(r =>
                        r.rear_gear_teeth != null ||
                        r.front_gear_teeth != null ||
                        r.rear_gear_num != null ||
                        r.front_gear_num != null
                      );

  return {
    gear_changes: gearChanges,
    records,
    di2_devices: di2Devices,
    sram_devices: sramDevices,
    campagnolo_devices: campagnoloDevices,
    groupset,
    session: fitData.sessions?.[0] || null,
    has_gear_data: hasGearData
  };
}
