/*
 * test-atlantic-dates.js — the date on the record is the date it happened
 * ---------------------------------------------------------------------------
 * These functions run on Vercel, which runs on UTC. A calendar date taken off
 * that clock is TOMORROW between 9 p.m. and midnight Atlantic in summer, and
 * 8 p.m. and midnight in winter. A non-conformance raised at half past nine in
 * the evening was dated tomorrow, and its five-working-day clock started a day
 * early.
 *
 * The failure is invisible at 2 p.m., which is when anybody would look. So the
 * evening is what this suite spends its assertions on.
 *
 * ⚠️ Every case here pins a REAL INSTANT and asserts the date it must produce.
 * A test that computed the expected value the same way the code does would
 * agree with any bug the code has.
 *
 * Run:  node _tests/test-atlantic-dates.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `got ${a}, expected ${e}`);
}
const say = s => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 70 - s.length)));

const W = require(path.join(__dirname, '..', 'api', '_when.js'));

say('1. The evening window — where the bug lived');
{
  // Atlantic Daylight Time, UTC−3. 21:00 local is midnight UTC.
  eq('20:59 ADT is still the 24th (and UTC agrees)',
     W.todayAtlantic(new Date('2026-09-24T23:59:00Z')), '2026-09-24');
  eq('21:00 ADT is STILL the 24th — UTC has already rolled over',
     W.todayAtlantic(new Date('2026-09-25T00:00:00Z')), '2026-09-24');
  eq('21:30 ADT, the half-nine close that started this',
     W.todayAtlantic(new Date('2026-09-25T00:30:00Z')), '2026-09-24');
  eq('23:59 ADT is the last minute of the 24th',
     W.todayAtlantic(new Date('2026-09-25T02:59:00Z')), '2026-09-24');
  eq('00:00 ADT rolls over, and only then',
     W.todayAtlantic(new Date('2026-09-25T03:00:00Z')), '2026-09-25');

  // The same instants, the old way. If these ever agree with the line above,
  // the zone lookup has silently stopped working.
  ok('the UTC reading of 21:30 ADT really is the NEXT day',
     new Date('2026-09-25T00:30:00Z').toISOString().slice(0, 10) === '2026-09-25',
     'if this fails the premise of the whole suite is wrong');
  ok('so the fix changes the answer, it does not just restate it',
     W.todayAtlantic(new Date('2026-09-25T00:30:00Z')) !==
     new Date('2026-09-25T00:30:00Z').toISOString().slice(0, 10));
}

say('2. Winter — the window is an hour longer');
{
  // Atlantic Standard Time, UTC−4. 20:00 local is midnight UTC.
  eq('19:59 AST is the 14th', W.todayAtlantic(new Date('2026-12-14T23:59:00Z')), '2026-12-14');
  eq('20:00 AST is STILL the 14th', W.todayAtlantic(new Date('2026-12-15T00:00:00Z')), '2026-12-14');
  eq('22:30 AST is the 14th', W.todayAtlantic(new Date('2026-12-15T02:30:00Z')), '2026-12-14');
  eq('00:00 AST rolls over', W.todayAtlantic(new Date('2026-12-15T04:00:00Z')), '2026-12-15');
}

say('3. The switch between them — why a fixed offset would be wrong');
{
  /* ⚠️ A hard-coded −3 or −4 passes half of this suite and fails the other
     half. NB moves on the first Sunday in November, 02:00 local. */
  eq('31 Oct 2026, 22:00 ADT (DST still on)',
     W.todayAtlantic(new Date('2026-11-01T01:00:00Z')), '2026-10-31');
  eq('1 Nov 2026, 22:00 AST (DST now off)',
     W.todayAtlantic(new Date('2026-11-02T02:00:00Z')), '2026-11-01');
  // Both instants are 22:00 local, three days apart, on opposite sides of the
  // switch — and they are 25 hours apart in UTC, not 24.
  const a = new Date('2026-11-01T01:00:00Z'), b = new Date('2026-11-02T02:00:00Z');
  eq('the two 22:00s are 25 UTC-hours apart', (b - a) / 3600000, 25);
}

say('4. Year and stamp');
{
  eq('31 Dec, 21:00 AST is still last year',
     W.yearAtlantic(new Date('2027-01-01T01:00:00Z')), 2026);
  eq('and the date agrees',
     W.todayAtlantic(new Date('2027-01-01T01:00:00Z')), '2026-12-31');
  eq('1 Jan, 00:30 AST is the new year',
     W.yearAtlantic(new Date('2027-01-01T04:30:00Z')), 2027);

  eq('the Activity Log stamp keeps its format, in local time',
     W.stampAtlantic(new Date('2026-09-25T00:30:00Z')), '2026-09-24 21:30');
  ok('the stamp is 16 characters, as the log has always been',
     W.stampAtlantic(new Date('2026-09-25T00:30:00Z')).length === 16);
  eq('midnight renders as 00, never 24',
     W.stampAtlantic(new Date('2026-09-25T03:00:00Z')), '2026-09-25 00:00');
  eq('and noon is not 00', W.stampAtlantic(new Date('2026-09-24T15:00:00Z')), '2026-09-24 12:00');

  /* ⚠️ Node renders midnight as '00' already, so the guard inside stampAtlantic
     is dead code HERE and a mutation removing it survived every assertion
     above. It is not dead on an ICU build that uses an h24 cycle, where it is
     the difference between '24:00' on the wrong day and a real time. Test the
     guard itself rather than a runtime that never triggers it. */
  eq("hour '24' is normalised to '00'", W.normalizeHour('24'), '00');
  eq("hour '00' is left alone", W.normalizeHour('00'), '00');
  eq("hour '23' is left alone", W.normalizeHour('23'), '23');
  eq("hour '09' is left alone", W.normalizeHour('09'), '09');

  /* A source assertion, deliberately. On Node, `hour12: false` already implies
     h23, so removing the explicit hourCycle changes nothing observable HERE —
     a behavioural test cannot see it, and a mutation removing it survives.
     What it protects is a runtime where the default cycle is h24. The only
     honest instrument for a flag whose effect is off-runtime is to check the
     flag is still asked for. */
  ok('the hour cycle is pinned explicitly, not left to the runtime default',
     /hourCycle: 'h23'/.test(fs.readFileSync(path.join(__dirname, '..', 'api', '_when.js'), 'utf8')),
     'without it an h24 build would write 24:00 into the Activity Log');
}

say('5. The zone is a zone, not an offset');
{
  ok('a named IANA zone is used', /America\//.test(W.TZ), W.TZ);
  ok('and it is a New Brunswick / Atlantic one', /Moncton|Halifax/.test(W.TZ), W.TZ);
}

say('6. The API uses it');
{
  const strip = x => x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const read = f => strip(fs.readFileSync(path.join(__dirname, '..', 'api', f), 'utf8'));

  for (const f of ['complaints.js', 'reminders.js']) {
    const src = read(f);
    ok(`${f} no longer derives a calendar date from the clock`,
       !/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(src),
       (src.match(/[^\n]*new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)[^\n]*/) || [''])[0].trim());
  }
  ok('complaints.js asks _when for the date', /require\('\.\/_when'\)/.test(read('complaints.js')));
  /* ⚠️ Date received is the start of the response clock on a public complaint,
     so an evening call logged under tomorrow gives the wrong deadline. */
  ok("'Date received' defaults to the Atlantic day",
     /if \(!body\.date\)\s+fields\[F\.date\]\s+= todayAtlantic\(\);/.test(read('complaints.js')));
  ok('and an explicit date from the form still wins',
     /if \(!body\.date\)/.test(read('complaints.js')),
     'the default must never overwrite what the person typed');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
