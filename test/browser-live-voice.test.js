import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserLiveVoice } from '../public/live-voice.js';
import { LiveVoiceGateway } from '../src/live-voice/gateway.js';
import { authToken, authCookieName } from '../src/config.js';

function harness({ media } = {}) {
 const statuses=[], sent=[], requests=[];
 const track={enabled:true,stopped:false,stop(){this.stopped=true;}};
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
 const audio={pause(){this.paused=true;},play:async()=>{},srcObject:null};
 let pc, ws;
 class Peer {
  constructor(){pc=this;this.iceGatheringState='complete';}
  addTrack(){} createDataChannel(){}
  async createOffer(){return {type:'offer',sdp:'offer\r\n'};}
  async setLocalDescription(d){this.localDescription=d;}
  async setRemoteDescription(d){this.remoteDescription=d;}
  close(){this.closed=true;}
 }
 class Socket {
  constructor(url){ws=this;this.url=url;this.readyState=1;}
  send(s){sent.push(JSON.parse(s));} close(){this.closed=true;}
 }
 const env={isSecureContext:true,navigator:{mediaDevices:{getUserMedia:media || (async()=>stream)}},RTCPeerConnection:Peer,WebSocket:Socket,
  location:{href:'https://example.com/codexremote/'},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({success:true,data:{ticket:'one-use'}})};}};
 const client=new BrowserLiveVoice({basePath:'/codexremote',audio,env,onStatus:s=>statuses.push(s)});
 return {client,statuses,sent,requests,track,stream,audio,env, get pc(){return pc;},get ws(){return ws;}};
}

test('browser voice authenticates with cookie ticket, negotiates WebRTC, mutes and releases audio',async()=>{
 const h=harness();await h.client.start('thread-1');
 assert.equal(h.requests[0].options.credentials,'same-origin');
 assert.equal(h.requests[0].options.headers.Authorization,undefined);
 assert.equal(h.ws.url,'wss://example.com/codexremote/api/voice-agent/sessions/thread-1/live');
 h.ws.onopen();assert.deepEqual(h.sent[0],{type:'authenticate',ticket:'one-use'});
 h.ws.onmessage({data:JSON.stringify({type:'ready'})});assert.deepEqual(h.sent[1],{type:'start',sdp:'offer\r\n'});
 h.ws.onmessage({data:JSON.stringify({type:'session.sdp',sdp:'answer\r\n'})});assert.equal(h.pc.remoteDescription.sdp,'answer\r\n');
 h.client.mute();assert.equal(h.track.enabled,false);
 h.client.mute();assert.equal(h.track.enabled,true);
 h.client.stop();assert.equal(h.track.stopped,true);assert.equal(h.pc.closed,true);assert.equal(h.ws.closed,true);
 assert.deepEqual(h.sent.at(-1),{type:'stop'});assert.equal(h.client.active,false);
});
test('stopping during microphone permission prevents a late stream from connecting',async()=>{
 let resolve;const h=harness({media:()=>new Promise(r=>resolve=r)});
 const starting=h.client.start('thread');h.client.stop();resolve(h.stream);await starting;
 assert.equal(h.track.stopped,true);assert.equal(h.requests.length,0);
});
test('gateway failure releases microphone and surfaces the error',async()=>{
 const h=harness();await h.client.start('thread');
 h.ws.onmessage({data:JSON.stringify({type:'session.error',message:'Codex voice unavailable'})});
 assert.equal(h.track.stopped,true);assert.equal(h.statuses.at(-1),'Codex voice unavailable');
});
test('insecure browsers do not request microphone access',async()=>{
 const h=harness();h.env.isSecureContext=false;
 await assert.rejects(h.client.start('thread'),/HTTPS/);assert.equal(h.client.active,false);
});
test('voice HTTP accepts web login cookie only with trusted origin, preserves Android auth',()=>{
 const gateway=new LiveVoiceGateway({token:'android'});
 const headers={cookie:`${authCookieName}=${authToken}`,origin:'https://example.com','sec-fetch-site':'same-origin'};
 let status;
 const res={setHeader(){},writeHead(code){status=code;},end(){}};
 assert.equal(gateway.authorizeHttp({headers},res),true);
 assert.equal(gateway.authorizeHttp({headers:{...headers,'sec-fetch-site':'cross-site'}},res),false);assert.equal(status,403);
 assert.equal(gateway.authorizeHttp({headers:{...headers,cookie:''}},res),false);assert.equal(status,401);
 assert.equal(gateway.authorizeHttp({headers:{...headers,cookie:'',authorization:`Basic ${Buffer.from('android:android').toString('base64')}`}},res),true);
});
