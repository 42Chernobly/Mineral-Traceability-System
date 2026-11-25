const chain = require('../src/hashchain');

function build(code, n) {
  const events = [];
  let prev = chain.genesisHash(code);
  for (let i = 1; i <= n; i++) {
    const e = {
      seq: i, event_type: i === 1 ? 'REGISTERED' : 'WEIGHBRIDGE', location: 'Kitwe', actor_id: 2,
      actor_role: 'mine', actor_org: 'Demo Mine', weight_kg: '1000.000', notes: 'n' + i,
      details: { b: 1, a: 2 }, occurred_at: new Date('2026-01-01T00:00:00.000Z'),
    };
    e.prev_hash = prev;
    e.hash = chain.computeEventHash(code, e, prev);
    prev = e.hash;
    events.push(e);
  }
  return { events, head: prev };
}

describe('SHA-256 hash chain', () => {
  const code = 'ZM-CU-2026-0001';

  test('canonicalize is key-order independent', () => {
    expect(chain.canonicalize({ b: 1, a: { d: 1, c: 2 } })).toBe(chain.canonicalize({ a: { c: 2, d: 1 }, b: 1 }));
  });

  test('valid chain verifies, including head anchor', () => {
    const { events, head } = build(code, 5);
    const r = chain.verifyChain(code, events, { head_hash: head, event_count: 5 });
    expect(r.valid).toBe(true);
    expect(r.checked).toBe(5);
  });

  test('altering any field breaks the chain at that event', () => {
    const { events } = build(code, 5);
    events[2].weight_kg = '900.000';
    const r = chain.verifyChain(code, events);
    expect(r.valid).toBe(false);
    expect(r.brokenAtSeq).toBe(3);
  });

  test('deleting a middle event is detected', () => {
    const { events } = build(code, 5);
    events.splice(1, 1);
    expect(chain.verifyChain(code, events).valid).toBe(false);
  });

  test('re-ordering events is detected', () => {
    const { events } = build(code, 4);
    [events[1], events[2]] = [events[2], events[1]];
    expect(chain.verifyChain(code, events).valid).toBe(false);
  });

  test('truncating the tail is caught by the head anchor', () => {
    const { events, head } = build(code, 5);
    const r = chain.verifyChain(code, events.slice(0, 4), { head_hash: head, event_count: 5 });
    expect(r.valid).toBe(false);
  });

  test('a recomputed forged chain still fails the head anchor', () => {
    const { events, head } = build(code, 3);
    // attacker edits event 2 and rewrites every later hash consistently
    events[1].notes = 'forged';
    let prev = events[0].hash;
    for (let i = 1; i < events.length; i++) {
      events[i].prev_hash = prev;
      events[i].hash = chain.computeEventHash(code, events[i], prev);
      prev = events[i].hash;
    }
    expect(chain.verifyChain(code, events).valid).toBe(true); // internally consistent...
    expect(chain.verifyChain(code, events, { head_hash: head, event_count: 3 }).valid).toBe(false); // ...but not the anchored head
  });

  test('same content under a different batch code yields a different chain', () => {
    expect(build('ZM-CU-2026-0001', 2).head).not.toBe(build('ZM-CU-2026-0002', 2).head);
  });
});
