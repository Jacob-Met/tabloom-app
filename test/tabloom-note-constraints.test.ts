import type { Bill } from "../src/tabloom.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureBill } from "../src/tabloom.js";
import { constrainNoteExclusions } from "../src/tabloom-note-constraints.js";
test("whole-table exclusion produces the explicit remaining group", () => {
 const bill=fixtureBill(); bill.items=[{id:"s",name:"Cucumber salad",cents:1000,sharedBy:[]}];
 const wrong=[{itemId:"s",guestIds:["mira"],reason:"Everyone except Mira shared it"}];
 bill.note="Everyone except Mira shared the cucumber salad.";
 assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,["joss","petra"]);
});
test("unseen postposed and additive exclusions preserve surviving proposal", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 bill.note="All three diners shared the flatbread except Mira. Joss paid the restaurant bill but ate none of the flatbread.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["mira","joss","petra"],reason:"all"}])[0].guestIds,["petra"]);
});
test("contradictory source requires a manual choice", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 bill.note="Everyone except Mira shared the flatbread. Correction: Mira ate the flatbread too.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["mira","joss"],reason:"all"}])[0].guestIds,[]);
});
test("conditional and reported exclusions are not interpreted as facts", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 const proposal=[{itemId:"s",guestIds:["mira","joss"],reason:"all"}];
 for(const note of ["If everyone except Mira shared the flatbread, check the bill.","Did everyone except Mira share the flatbread?","Everyone except Mira shared the flatbread?","The waiter asked whether everyone except Mira shared the flatbread."]){
 bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,proposal),proposal);
 }
});

test("explicit corrected sole owner supplies a reviewable choice even when model omitted it", () => {
 const bill=fixtureBill();bill.guests=[{id:"lena",name:"Lena"},{id:"ravi",name:"Ravi"},{id:"june",name:"June"}];
 bill.items=[{id:"s",name:"Sesame noodles",cents:1000,sharedBy:[]}];
 bill.note="Lena initially claimed the sesame noodles, but corrected herself: those were Ravi's alone.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:[],reason:"unknown"}])[0].guestIds,["ravi"]);
});
test("unfamiliar exact sole-owner statements replace incorrect model guesses", () => {
 const bill=fixtureBill();bill.guests=[{id:"nia",name:"Nia"},{id:"luis",name:"Luis"},{id:"chen",name:"Chen"}];
 bill.items=[{id:"s",name:"Roast aubergine",cents:1000,sharedBy:[]}];
 const wrong=[{itemId:"s",guestIds:["nia","chen"],reason:"all"}];
 for(const note of ["Correction: only Luis ate the roast aubergine, not Chen.","The roast aubergine was Luis’s alone."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,["luis"]);
 }
});
test("sole-owner conflicts and later unresolved references require manual choice", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 const wrong=[{itemId:"s",guestIds:["mira"],reason:"Mira"}];
 for(const note of ["Only Mira ate the flatbread. Only Joss ate the flatbread.","Only Mira ate the flatbread. Joss shared it too.","Only Mira ate the flatbread. We sat outside. Joss shared it too.","Only Mira ate the flatbread. Mira did not eat the flatbread."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,[]);
 }
});
test("questions, conditions, unknown and duplicate names do not create owners", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 const unresolved=[{itemId:"s",guestIds:[],reason:"unknown"}];
 for(const note of ["Only Mira ate the flatbread?","If only Mira ate the flatbread, ask her.","The waiter said only Mira ate the flatbread.","Only Unknown ate the flatbread.","Only Mira ate the flatbread, not Unknown."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,unresolved),unresolved);
 }
 bill.guests[1].name="Mira";bill.note="Only Mira ate the flatbread.";
 assert.deepEqual(constrainNoteExclusions(bill,unresolved),unresolved);
});

test("direct exclusion alone does not invent the remaining owners", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];bill.note="Mira did not eat the flatbread.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["mira"],reason:"wrong"}])[0].guestIds,[]);
});
test("whole-table count, conflicting groups and unresolved reference require choice", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 for(const note of [
  "All four diners shared the flatbread except Mira.",
  "Everyone except Mira shared the flatbread. Everyone except Joss shared the flatbread.",
  "Everyone except Mira shared the flatbread. We sat outside. Mira shared it too."
 ]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["joss","petra"],reason:"guess"}])[0].guestIds,[]);
 }
});
test("unfamiliar whole-table group replaces an omitted model assignment", () => {
 const bill=fixtureBill();bill.guests=[{id:"nia",name:"Nia"},{id:"luis",name:"Luis"},{id:"omar",name:"Omar"},{id:"chen",name:"Chen"}];
 bill.items=[{id:"s",name:"Rosemary focaccia",cents:1000,sharedBy:[]}];
 bill.note="All four diners shared the rosemary focaccia except Omar. Nia paid the restaurant bill but ate none of the rosemary focaccia.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:[],reason:"unknown"}])[0].guestIds,["luis","chen"]);
});

test("explicitly forgotten item never inherits an invented model owner", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Orange tart",cents:1000,sharedBy:[]}];
 for(const note of ["Nobody remembers the extra orange tart.","No one knows who ate the orange tart.","The receipt also lists an orange tart; nobody remembers who ordered it.","Nobody can place the orange tart.","Nobody remembers the extra orange tart. Only Mira ate the orange tart."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["mira"],reason:"invented"}])[0].guestIds,[]);
 }
});
test("uncertainty questions and reported statements do not become source facts", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Orange tart",cents:1000,sharedBy:[]}];
 const proposal=[{itemId:"s",guestIds:["mira"],reason:"Mira"}];
 for(const note of ["Nobody remembers the extra orange tart?","If nobody remembers the extra orange tart, ask the waiter.","The waiter said nobody remembers the extra orange tart."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,proposal),proposal);
 }
});


test("exact unfamiliar named groups replace omitted or incorrect proposals", () => {
 const bill=fixtureBill();bill.guests=[{id:"nia",name:"Nia"},{id:"luis",name:"Luis"},{id:"chen",name:"Chen"}];
 bill.items=[{id:"s",name:"Roast aubergine",cents:1000,sharedBy:[]}];
 for(const [note,expected] of [["Luis and Chen shared the roast aubergine.",["luis","chen"]],["Chen and Luis had the roast aubergine.",["luis","chen"]],["Nia, Luis, and Chen ate the roast aubergine.",["nia","luis","chen"]]] as const){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["nia"],reason:"guess"}])[0].guestIds,expected);
 }
});
test("named groups retain uncertainty, duplicate names and contradictory details", () => {
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 const empty=[{itemId:"s",guestIds:[],reason:"unknown"}];
 for(const note of ["Joss and Petra shared the flatbread?","If Joss and Petra shared the flatbread, ask them.","The waiter said Joss and Petra shared the flatbread.","Joss and Unknown shared the flatbread.","Joss and Joss shared the flatbread."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty),empty);}
 for(const note of ["Joss and Petra shared the flatbread. Only Mira ate the flatbread.","Joss and Petra shared the flatbread. Joss did not eat the flatbread.","Joss and Petra shared the flatbread. Mira had it too."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["joss"],reason:"guess"}])[0].guestIds,[]);}
 bill.guests[0].name="Joss";bill.note="Joss and Petra shared the flatbread.";assert.deepEqual(constrainNoteExclusions(bill,empty),empty);
});


test("semicolon notes preserve independent ownership and connected unknown references",()=>{
 const bill=fixtureBill();bill.items=[{id:"bread",name:"Flatbread",cents:1200,sharedBy:[]},{id:"tea",name:"Jasmine tea",cents:400,sharedBy:[]},{id:"tart",name:"Orange tart",cents:700,sharedBy:[]}];
 const wrong=bill.items.map(i=>({itemId:i.id,guestIds:["mira"],reason:"guess"}));
 for(const separator of ["; ",";"]){
  bill.note=["Joss and Petra shared the flatbread","Only Joss had the jasmine tea","The receipt also lists an orange tart","nobody remembers who ordered it"].join(separator)+".";
  assert.deepEqual(constrainNoteExclusions(bill,wrong).map(s=>s.guestIds),[["joss","petra"],["joss"],[]]);
 }
 bill.note="Only Mira ate the flatbread; Only Joss ate the flatbread.";
 assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,[]);
 bill.note="Only Mira ate the flatbread; Joss shared it too.";
 assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,[]);
});


test("an immediate uncertain recollection keeps its preceding ownership claim manual",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Flatbread",cents:1000,sharedBy:[]}];
 const wrong=[{itemId:"s",guestIds:["mira","joss"],reason:"guess"}];
 for(const claim of ["Only Mira ate the flatbread.","Joss and Petra shared the flatbread.","Everyone except Mira shared the flatbread.","Mira did not eat the flatbread."]){
  for(const qualifier of ["I'm not sure.","We are uncertain.","Actually, I might be wrong.","Not certain.","Actually, I'm not sure?","We are uncertain?","I might be wrong?","Not certain?"]){bill.note=claim+" "+qualifier;assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,[]);}
 }
 bill.note="Only Mira ate the flatbread. I am certain.";
 assert.deepEqual(constrainNoteExclusions(bill,wrong)[0].guestIds,["mira"]);
 bill.items.push({id:"t",name:"Jasmine tea",cents:300,sharedBy:[]});bill.note="Only Mira ate the flatbread. Only Joss had the jasmine tea. I'm not sure.";
 assert.deepEqual(constrainNoteExclusions(bill,[...wrong,{itemId:"t",guestIds:["joss"],reason:"guess"}]).map(s=>s.guestIds),[["mira"],[]]);
});


test("explicit whole-table claims stay reviewable and conflicting claims remain manual",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Roast aubergine",cents:1000,sharedBy:[]}];
 const empty=[{itemId:"s",guestIds:[],reason:"unknown"}];
 for(const claim of ["Everyone shared the roast aubergine.","Everybody had roast aubergine.","All diners ate the roast aubergine."]){
  bill.note=claim;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,bill.guests.map(g=>g.id));
  for(const followup of [" I'm not sure."," Only Joss had the roast aubergine."," Mira did not eat the roast aubergine."]){bill.note=claim+followup;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,[]);}
 }
 for(const note of ["Everyone shared the roast aubergine?","The waiter said everyone shared the roast aubergine.","If everybody had roast aubergine, split it.","Everyone shared the roast aubergine except Mira?"]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty),empty);}
});


test("an exclusion remains reviewable when no model owner was supplied",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Rosemary focaccia",cents:1000,sharedBy:[]}];
 bill.note="Mira did not eat the rosemary focaccia.";
 const result=constrainNoteExclusions(bill,[{itemId:"s",guestIds:[],reason:"unknown"}])[0];
 assert.deepEqual(result.guestIds,[]);assert.match(result.reason,/Excluded in your note: Mira/);
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["joss"],reason:"Joss"}])[0].guestIds,["joss"]);
 bill.note+=" I'm not sure.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["joss"],reason:"Joss"}])[0].guestIds,[]);
});


test("large groups keep recovery-compatible reasons without dropping owners",()=>{
 const bill=fixtureBill();bill.guests=Array.from({length:8},(_,i)=>({id:"g"+i,name:"Guest "+i+" Alexandria Catherine Nguyen-Williams"}));
 bill.items=[{id:"s",name:"Roast aubergine",cents:1000,sharedBy:[]}];
 bill.note="Everyone shared the roast aubergine.";
 const all=bill.guests.map(g=>g.id);let proposal=constrainNoteExclusions(bill,[{itemId:"s",guestIds:[],reason:"unknown"}])[0];
 assert.deepEqual(proposal.guestIds,all);assert.ok(proposal.reason.length<=240);
 bill.note=bill.guests.slice(0,6).map(g=>g.name+" did not eat the roast aubergine.").join(" ");
 proposal=constrainNoteExclusions(bill,[{itemId:"s",guestIds:all,reason:"all"}])[0];
 assert.deepEqual(proposal.guestIds,all.slice(6));assert.ok(proposal.reason.length<=240);
});

test("punctuation inside supplied receipt and diner names does not split ownership clauses",()=>{
 const bill=fixtureBill();bill.guests[1].name="Dr. Joss";
 bill.items=[{id:"s",name:"Dr. Pepper",cents:350,sharedBy:[]}];
 const empty=[{itemId:"s",guestIds:[],reason:"unknown"}];
 for(const note of ["Only Dr. Joss had the Dr. Pepper.","Only Dr. Joss had the Dr. Pepper; we sat outside.","Only Dr.  Joss had the Dr.  Pepper."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
 }
 for(const note of ["Only Dr. Joss had the Dr. Pepper. Only Mira had the Dr. Pepper.","Only Dr. Joss had the Dr. Pepper. I'm not sure.","Only Dr. Joss had the Dr. Pepper; Mira had it too."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,[]);
 }
 bill.note="Only Dr. Joss had the Dr. Pepper?";
 assert.deepEqual(constrainNoteExclusions(bill,empty),empty);
 bill.note="Nobody remembers who had the Dr. Pepper.";
 assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"s",guestIds:["mira"],reason:"guess"}])[0].guestIds,[]);
});

test("a short named correction makes the prior item a manual choice",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"t",name:"Tea",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["Actually, Petra.","Actually Petra.","Correction: Petra."]){
  bill.note="Only Joss ate the dumplings. "+correction;
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],[]]);
 }
 bill.note="Only Joss ate the dumplings. Only Mira had the tea. Actually, Petra.";
 assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[["joss"],[]]);
 bill.note="Only Joss ate the dumplings. Actually, we sat beside Petra.";
 assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
});

test("explicit personal meals and split groups are source facts across unfamiliar names",()=>{
 const bill=fixtureBill();bill.guests=[{id:"r",name:"Rosa"},{id:"e",name:"Emil"},{id:"n",name:"Nour"}];
 bill.items=[{id:"dish",name:"Lemon sole",cents:1200,sharedBy:[]}];const empty=[{itemId:"dish",guestIds:[],reason:"unknown"}];
 for(const note of ["The lemon sole was Rosa's meal, not Emil's.","Lemon sole was Rosa’s dish.","The lemon sole was Rosa's drink."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["r"]);}
 for(const note of ["Emil and Nour split the lemon sole.","Nour and Emil split lemon sole between them."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["e","n"]);}
 for(const note of ["The lemon sole was Unknown's meal.","The lemon sole was Rosa's meal, not Unknown's.","The lemon sole was Rosa's meal, not Rosa's.","The lemon sole was Rosa's meal?","If the lemon sole was Rosa's meal, ask her.","The waiter said the lemon sole was Rosa's meal.","Emil and Nour split the lemon sole?","Emil and Unknown split the lemon sole.","Emil and Emil split the lemon sole."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,empty),empty);}
 for(const note of ["The lemon sole was Rosa's meal. The lemon sole was Emil's meal.","The lemon sole was Rosa's meal. Actually, Nour.","Emil and Nour split the lemon sole between them. Only Rosa ate the lemon sole.","The lemon sole was Rosa's meal. I'm not sure."]){bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,[{itemId:"dish",guestIds:["r"],reason:"guess"}])[0].guestIds,[]);}
 bill.guests[1].name="Rosa";bill.note="The lemon sole was Rosa's meal.";assert.deepEqual(constrainNoteExclusions(bill,empty),empty);
});


test("first-person forgotten ownership remains manual without treating unrelated forgetting as ownership",()=>{
 const bill=fixtureBill();bill.items=[{id:"drink",name:"Lemon tonic",cents:475,sharedBy:[]}];
 const guess=[{itemId:"drink",guestIds:[bill.guests[0].id],reason:"model guess"}];
 for(const note of ["We forgot who had the lemon tonic.","I forgot who ordered lemon tonic.","We cannot remember who drank the lemon tonic.","I can't recall who shared the lemon tonic.","We don’t remember who ate the lemon tonic.","I do not recall who had the lemon tonic.","Only Joss had the lemon tonic. We forgot who had the lemon tonic."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,guess)[0].guestIds,[],note);
 }
 for(const note of ["We forgot the lemon tonic.","We forgot to order the lemon tonic.","We forgot who had the lemon tonic?","If we forgot who had the lemon tonic, ask Joss.","Joss said we forgot who had the lemon tonic.","We forgot who did not have the lemon tonic."]){
  bill.note=note;assert.deepEqual(constrainNoteExclusions(bill,guess),guess,note);
 }
});


test("a short negated name retracts the preceding item owner without choosing another diner",()=>{
 const bill={guests:[{id:"joss",name:"Joss"},{id:"petra",name:"Petra"}],items:[{id:"rice",name:"Rice"},{id:"tea",name:"Tea"}],note:""} as Bill;
 const suggestions=[{itemId:"rice",guestIds:["joss"],reason:"Wrong prior owner"},{itemId:"tea",guestIds:["petra"],reason:"Other item"}];
 for(const correction of ["Actually, not Joss.","Actually not Joss.","Correction: not Joss.","Not Joss.","Actually, not Joss?","Not Joss?","Correction: someone else.","Actually, I cannot remember."]){
  bill.note="Only Joss had rice. "+correction+" Only Petra had tea.";
  const constrained=constrainNoteExclusions(bill,suggestions);assert.deepEqual(constrained[0].guestIds,[]);assert.deepEqual(constrained[1].guestIds,["petra"]);
 }
 bill.note="Only Joss had rice. Only Petra had tea. Actually, not Petra.";
 const constrained=constrainNoteExclusions(bill,suggestions);assert.deepEqual(constrained[0].guestIds,["joss"]);assert.deepEqual(constrained[1].guestIds,[]);
});

test("short named-group corrections retract only the preceding item claim",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"t",name:"Tea",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["Actually, Mira and Petra.","Correction: Mira, Joss and Petra.","Actually Mira and Petra?"]){
  bill.note="Only Joss ate the dumplings. "+correction+" Only Mira had tea.";
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],["mira"]]);
 }
 bill.note="Only Joss ate dumplings. Only Mira had tea. Actually, Joss and Petra.";
 assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[["joss"],[]]);
 bill.note="Only Joss ate dumplings. Actually, we sat beside Mira and Petra.";
 assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
});

test("short uncertain alternatives cannot preserve a preceding sole-owner claim",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"t",name:"Tea",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["Actually, either Mira or Petra.","Correction: Mira or Petra.","Actually, perhaps Mira.","Actually only Petra.","Actually, Mira, Joss or Petra.","Actually, Mira and Mira."]){
  bill.note="Only Joss ate dumplings. "+correction+" Only Mira had tea.";
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],["mira"]]);
 }
 bill.note="Only Joss ate dumplings. Actually, Mira or Petra drove home.";
 assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
});

test("a dish-name substring inside a diner name cannot redirect a short correction",()=>{
 const bill=fixtureBill();bill.guests[2].name="Beatrice";bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"r",name:"Rice",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["Actually, Beatrice.","Correction: Mira and Beatrice.","Actually, either Mira or Beatrice."]){
  bill.note="Only Joss ate dumplings. "+correction+" Only Mira had rice.";
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],["mira"]]);
 }
 bill.note="Only Joss ate dumplings. Only Beatrice had rice. Actually, Mira.";
 assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[["joss"],[]]);
 bill.note="Only Joss ate dumplings. Actually, Beatrice drove home. Only Mira had rice.";
 assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[["joss"],["mira"]]);
});

test("a diner sharing an exact dish name still retracts the preceding owner",()=>{
 const bill=fixtureBill();bill.guests[2].name="Chai";bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"t",name:"Chai",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["Actually, Chai.","Correction: Mira and Chai.","Actually, either Mira or Chai."]){
  bill.note="Only Joss ate dumplings. "+correction+" We forgot who had chai.";
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],[]]);
 }
 bill.note="Only Joss ate dumplings. Only Mira had chai. Actually, Chai.";
 assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[["joss"],[]]);
 bill.note="Only Joss ate dumplings. Actually, Chai drove home.";
 assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
});

test("plain no and wait corrections withdraw prior ownership without inferring a replacement",()=>{
 const bill=fixtureBill();bill.items=[{id:"s",name:"Dumplings",cents:1400,sharedBy:[]},{id:"t",name:"Tea",cents:350,sharedBy:[]}];
 const empty=bill.items.map(item=>({itemId:item.id,guestIds:[],reason:"unknown"}));
 for(const correction of ["No, Petra.","Wait, Mira and Petra.","No: either Mira or Petra.","Actually: Petra.","Wait, I'm not sure.","No, someone else."]){
  bill.note="Only Joss ate dumplings. "+correction+" Only Mira had tea.";
  assert.deepEqual(constrainNoteExclusions(bill,empty).map(s=>s.guestIds),[[],["mira"]]);
 }
 for(const sentence of ["No, Petra drove home.","Wait, we sat beside Petra."]){
  bill.note="Only Joss ate dumplings. "+sentence;
  assert.deepEqual(constrainNoteExclusions(bill,empty)[0].guestIds,["joss"]);
 }
});
