import test from 'node:test';
import assert from 'node:assert/strict';
import { userInputDisplay, validateUserInputAnswers } from '../src/user-input.js';
import { CodexAppServer } from '../src/codex-server.js';
const question = {id:'timeout',question:'多久自动提交？',isOther:true,options:[{label:'60 秒 (Recommended)'},{label:'120 秒'},{label:'300 秒'}]};
test('async questions default to 60 seconds; explicit official timeout and zero are preserved',()=>{
 assert.equal(userInputDisplay({isBlocking:false,questions:[question]},1000).autoSubmitAt,61000);
 assert.equal(userInputDisplay({isBlocking:false,autoResolutionMs:120000,questions:[question]},1000).autoSubmitAt,121000);
 assert.equal(userInputDisplay({isBlocking:false,autoResolutionMs:0,questions:[question]},1000).autoSubmitAt,1000);
});
test('blocking confirmations, permission choices, secrets and free text do not auto-submit',()=>{
 for(const params of [
 {isBlocking:true,questions:[question]},
 {questions:[question]},
 {isBlocking:false,questions:[{...question,options:[{label:'Accept'},{label:'Decline'},{label:'Cancel'}]}]},
 {isBlocking:false,questions:[{...question,isSecret:true}]},
 {isBlocking:false,questions:[{...question,options:null}]}
 ])assert.equal(userInputDisplay(params,1000).autoSubmitAt,null);
});
test('other means free text, not multiple choices; invalid submissions remain pending',()=>{
 const sent=[];
 const server=new CodexAppServer({send:line=>sent.push(JSON.parse(line))},{notifyApprovalRequired(){}});
 server.onLine(JSON.stringify({id:42,method:'item/tool/requestUserInput',params:{isBlocking:false,questions:[question]}}));
 const first=server.pendingApprovalRequests()[0];
 assert.equal(first.isBlocking,false);
 assert.equal(first.autoSubmitAt,server.pendingApprovalRequests()[0].autoSubmitAt);
 assert.throws(()=>server.respondToApprovalRequest({requestId:42,decision:'accept',answers:{timeout:{answers:['60 秒','120 秒']}}}),/每个问题/);
 assert.equal(server.hasPendingServerRequest(42),true);
 server.respondToApprovalRequest({requestId:42,decision:'accept',answers:{timeout:{answers:['自定义等待时间']}}});
 assert.deepEqual(sent.at(-1).result,{answers:{timeout:{answers:['自定义等待时间']}}});
 assert.equal(server.hasPendingServerRequest(42),false);
});
test('all questions require an answer and closed choices cannot be invented',()=>{
 const qs=userInputDisplay({questions:[{...question,isOther:false}, {id:'text',question:'说明'}]}).questions;
 assert.throws(()=>validateUserInputAnswers(qs,{timeout:{answers:['wrong']},text:{answers:['ok']}}),/不在选项/);
 assert.throws(()=>validateUserInputAnswers(qs,{timeout:{answers:['120 秒']}}),/每个问题/);
});

import { parseSessionFile } from '../src/threads.js';
test('async AgentMessage questions survive transcript parsing, and later user input closes them', () => {
 const event = {type:'event_msg',timestamp:'2026-10-05T04:37:35.176Z',payload:{type:'item_completed',turn_id:'t',item:{type:'AgentMessage',id:'call-async',delivery:'async',content:[{type:'Text',text:'选择主题'}],questions:[{title:'选择主题',options:['深色（推荐）','浅色']}]}}};
 const parsed = parseSessionFile(JSON.stringify(event));
 assert.equal(parsed.messages[0].inputQuestions[0].options[1], '浅色');
 assert.equal(parsed.messages[0].inputResolved,false);
 const replied = parseSessionFile(JSON.stringify(event)+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{text:'浅色'}]}}));
 assert.equal(replied.messages[0].inputResolved,true);
});
test('async questions are retained in realtime events and saved answers', () => {
 const server = new CodexAppServer({send(){}},{notifyApprovalRequired(){}});
 const events=[]; server.emit=e=>events.push(e);
 server.turn={threadId:'t',turnId:'turn',startedAtMs:Date.now(),answers:[],answerMessages:[]};
 const questions=[{title:'主题',options:['深色','浅色']}];
 server.onNotification({method:'item/completed',params:{threadId:'t',turnId:'turn',item:{type:'agentMessage',id:'async',text:'主题',phase:'final_answer',delivery:'async',questions}}});
 assert.deepEqual(events.find(e=>e.type==='message').inputQuestions,questions);
 assert.deepEqual(server.turn.answerMessages[0].inputQuestions,questions);
});

test('async choices notify Android once per item, but plain replies and empty questions do not', () => {
 const notifications=[];
 const server=new CodexAppServer({send(){}},{notifyApprovalRequired:r=>notifications.push(r)});
 server.emit=()=>{};
 server.turn={threadId:'t',turnId:'turn',startedAtMs:Date.now(),answers:[],answerMessages:[]};
 const deliver=(id,questions)=>server.onNotification({method:'item/completed',params:{threadId:'t',turnId:'turn',item:{type:'agentMessage',id,text:'主题',phase:'final_answer',questions}}});
 deliver('q',[{title:'你最喜欢哪种主题？',options:['深色','浅色']}]);
 deliver('q',[{title:'重复事件',options:['深色','浅色']}]);
 deliver('plain',undefined); deliver('empty',[]);
 assert.equal(notifications.length,1);
 assert.equal(notifications[0].kind,'input');
 assert.equal(notifications[0].summary,'你最喜欢哪种主题？');
});
