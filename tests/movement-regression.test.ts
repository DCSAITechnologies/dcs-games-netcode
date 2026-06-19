import { validateMovement, LIMITS } from '../src/validation';
let pass=0,fail=0; const c=(n,x)=>{x?pass++:fail++;console.log((x?'✅':'❌')+' '+n);};
const origin={x:0,y:0,z:0};
const dt=1/15; const maxDist=LIMITS.MAX_MOVE_SPEED*dt; // ~0.533

// legit walk (half max)
let r=validateMovement(origin,{type:'input',seq:1,move:{x:maxDist*0.5,y:0,z:0},look:{yaw:0,pitch:0},dt});
c('legit walk accepted', r.valid===true);
c('legit walk not clamped (full move applied)', Math.abs(r.corrected.x-maxDist*0.5)<1e-9);

// minor jitter (1.3x) → clamped, accepted
r=validateMovement(origin,{type:'input',seq:2,move:{x:maxDist*1.3,y:0,z:0},look:{yaw:0,pitch:0},dt});
c('minor jitter accepted', r.valid===true);
c('minor jitter clamped to maxDist', Math.abs(r.corrected.x-maxDist)<1e-6);

// gross speedhack (1000) → rejected, snap back
r=validateMovement(origin,{type:'input',seq:3,move:{x:1000,y:0,z:0},look:{yaw:0,pitch:0},dt});
c('gross speedhack rejected', r.valid===false);
c('gross speedhack snaps to origin', r.corrected.x===0);

// exactly at limit → accepted
r=validateMovement(origin,{type:'input',seq:4,move:{x:maxDist,y:0,z:0},look:{yaw:0,pitch:0},dt});
c('exactly-at-limit accepted', r.valid===true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
