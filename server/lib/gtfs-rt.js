// Dekoder GTFS-Realtime (Protocol Buffers) bez zależności.
// Obsługuje to, czego potrzebuje LuźnyBus: TripUpdate, VehiclePosition (z occupancy_status), nagłówek.
// Numery pól wg https://gtfs.org/realtime/proto/

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.b = buf;
    this.p = start;
    this.end = end;
  }

  eof() { return this.p >= this.end; }

  varint() {
    let lo = 0, shift = 0, byte;
    // szybka ścieżka do 2^28
    do {
      byte = this.b[this.p++];
      if (shift < 28) lo |= (byte & 0x7f) << shift;
      else return this.varintSlow(lo, shift, byte);
      shift += 7;
    } while (byte & 0x80);
    return lo >>> 0;
  }

  varintSlow(lo, shift, byte) {
    let v = BigInt(lo >>> 0);
    let s = BigInt(shift);
    for (;;) {
      v |= BigInt(byte & 0x7f) << s;
      if (!(byte & 0x80)) break;
      s += 7n;
      byte = this.b[this.p++];
    }
    return v; // BigInt dla dużych wartości
  }

  int() {
    // int32/int64 zakodowane w uzupełnieniu do dwóch
    const v = this.varint();
    if (typeof v === 'bigint') return Number(BigInt.asIntN(64, v));
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }

  uint() {
    const v = this.varint();
    return typeof v === 'bigint' ? Number(v) : v;
  }

  float() { const v = this.b.readFloatLE(this.p); this.p += 4; return v; }
  double() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  bytes() { const len = this.uint(); const s = this.p; this.p += len; return [s, this.p]; }
  string() { const [s, e] = this.bytes(); return this.b.toString('utf8', s, e); }
  sub() { const [s, e] = this.bytes(); return new Reader(this.b, s, e); }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.p += 4;
    else throw new Error(`protobuf: nieznany typ ${wire}`);
  }

  /** Iteracja po polach: fn(numer, typ) zwraca true, jeśli pole obsłużyła. */
  fields(fn) {
    while (!this.eof()) {
      const key = this.uint();
      const field = key >>> 3, wire = key & 7;
      if (!fn(field, wire)) this.skip(wire);
    }
  }
}

function tripDescriptor(r) {
  const t = {};
  r.fields((f) => {
    if (f === 1) t.tripId = r.string();
    else if (f === 2) t.startTime = r.string();
    else if (f === 3) t.startDate = r.string();
    else if (f === 4) t.scheduleRelationship = r.uint();
    else if (f === 5) t.routeId = r.string();
    else if (f === 6) t.directionId = r.uint();
    else return false;
    return true;
  });
  return t;
}

function vehicleDescriptor(r) {
  const v = {};
  r.fields((f) => {
    if (f === 1) v.id = r.string();
    else if (f === 2) v.label = r.string();
    else if (f === 3) v.licensePlate = r.string();
    else return false;
    return true;
  });
  return v;
}

function stopTimeEvent(r) {
  const e = {};
  r.fields((f) => {
    if (f === 1) e.delay = r.int();
    else if (f === 2) e.time = r.int();
    else if (f === 3) e.uncertainty = r.int();
    else return false;
    return true;
  });
  return e;
}

function stopTimeUpdate(r) {
  const u = {};
  r.fields((f) => {
    if (f === 1) u.stopSequence = r.uint();
    else if (f === 2) u.arrival = stopTimeEvent(r.sub());
    else if (f === 3) u.departure = stopTimeEvent(r.sub());
    else if (f === 4) u.stopId = r.string();
    else if (f === 5) u.scheduleRelationship = r.uint();
    else return false;
    return true;
  });
  return u;
}

function tripUpdate(r) {
  const t = { stopTimeUpdates: [] };
  r.fields((f) => {
    if (f === 1) t.trip = tripDescriptor(r.sub());
    else if (f === 2) t.stopTimeUpdates.push(stopTimeUpdate(r.sub()));
    else if (f === 3) t.vehicle = vehicleDescriptor(r.sub());
    else if (f === 4) t.timestamp = r.uint();
    else if (f === 5) t.delay = r.int();
    else return false;
    return true;
  });
  return t;
}

function position(r) {
  const p = {};
  r.fields((f, w) => {
    if (f === 1 && w === 5) p.lat = r.float();
    else if (f === 2 && w === 5) p.lng = r.float();
    else if (f === 3 && w === 5) p.bearing = r.float();
    else if (f === 4 && w === 1) p.odometer = r.double();
    else if (f === 5 && w === 5) p.speed = r.float();
    else return false;
    return true;
  });
  return p;
}

function vehiclePosition(r) {
  const v = {};
  r.fields((f) => {
    if (f === 1) v.trip = tripDescriptor(r.sub());
    else if (f === 2) v.position = position(r.sub());
    else if (f === 3) v.currentStopSequence = r.uint();
    else if (f === 4) v.currentStatus = r.uint();
    else if (f === 5) v.timestamp = r.uint();
    else if (f === 6) v.congestionLevel = r.uint();
    else if (f === 7) v.stopId = r.string();
    else if (f === 8) v.vehicle = vehicleDescriptor(r.sub());
    else if (f === 9) v.occupancyStatus = r.uint();
    else if (f === 10) v.occupancyPercentage = r.uint();
    else return false;
    return true;
  });
  return v;
}

export function decodeFeed(buf) {
  const r = new Reader(buf);
  const msg = { header: {}, entities: [] };
  r.fields((f) => {
    if (f === 1) {
      const h = r.sub();
      h.fields((g) => {
        if (g === 1) msg.header.version = h.string();
        else if (g === 2) msg.header.incrementality = h.uint();
        else if (g === 3) msg.header.timestamp = h.uint();
        else return false;
        return true;
      });
    } else if (f === 2) {
      const e = r.sub();
      const ent = {};
      e.fields((g) => {
        if (g === 1) ent.id = e.string();
        else if (g === 2) ent.isDeleted = !!e.uint();
        else if (g === 3) ent.tripUpdate = tripUpdate(e.sub());
        else if (g === 4) ent.vehicle = vehiclePosition(e.sub());
        else return false;
        return true;
      });
      msg.entities.push(ent);
    } else return false;
    return true;
  });
  return msg;
}

export const VehicleStopStatus = { INCOMING_AT: 0, STOPPED_AT: 1, IN_TRANSIT_TO: 2 };

/** OccupancyStatus (GTFS-RT) → poziom LuźnyBusa 0..3 (null = brak danych). */
export function occupancyStatusToLevel(s) {
  if (s == null || s === 7 || s === 8) return null;
  if (s <= 1) return 0;
  if (s === 2) return 1;
  if (s === 3) return 2;
  return 3;
}

// --- enkoder (tylko do testów) ---------------------------------------------------
export function encodeForTest(fields) {
  // fields: [[num, type, value]], type: 'varint'|'string'|'float'|'msg'
  const parts = [];
  const varint = (v) => {
    const out = [];
    let x = BigInt.asUintN(64, BigInt(v));
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      out.push(b);
    } while (x);
    return Buffer.from(out);
  };
  for (const [num, type, value] of fields) {
    if (type === 'varint') parts.push(varint((num << 3) | 0), varint(value));
    else if (type === 'float') { const b = Buffer.alloc(4); b.writeFloatLE(value); parts.push(varint((num << 3) | 5), b); }
    else {
      const b = type === 'msg' ? encodeForTest(value) : Buffer.from(value, 'utf8');
      parts.push(varint((num << 3) | 2), varint(b.length), b);
    }
  }
  return Buffer.concat(parts);
}
