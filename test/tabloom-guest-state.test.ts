import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TabloomGuestState} from "../src/tabloom-guest-state.js";
test("stopped reply updates persist while callbacks from the old invitation epoch cannot revive links",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tabloom-reply-state-"));
 try{
  const store=new TabloomGuestState(join(dir,"invitations.json"));
  const active=await store.enable("http://127.0.0.1:3001");
  const replies=[{stopped:true,response:{items:[]}}];
  const stopped=await store.disable(active.origin,replies);
  assert.equal(await store.saveSessions(active.epoch,[{old:true}]),false);
  assert.deepEqual((await store.read()).sessions,replies);
  assert.equal(await store.saveSessions(stopped.epoch,[]),true);
  assert.equal((await store.read()).enabled,false);
  const fresh=await store.enable("http://127.0.0.1:3002",replies);
  assert.deepEqual(fresh.sessions,replies);
  assert.equal(await store.saveSessions(stopped.epoch,[]),false);
  assert.deepEqual((await store.read()).sessions,replies);
 }finally{await rm(dir,{recursive:true,force:true});}
});
