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

  const hasGearData = gearChanges.length > 0 ||
                      records.some(r => r.rear_gear_num !== undefined);

  return {
    gear_changes: gearChanges,
    records,
    di2_devices: di2Devices,
    session: fitData.sessions?.[0] || null,
    has_gear_data: hasGearData
  };
}
