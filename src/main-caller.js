'use strict';
const {randomUUID}=require('node:crypto');
// Session-local policy; no audio or Discord transport in this state machine.
class MainCaller {
 constructor(id,now=Date.now){this.now=now;this.startedWithMain=!!id;this.id=id || null;this.paused=false;this.channelId=null;this.available=false;this.absence=null;this.waited=null;this.followError=null;}
 select(ids){if(!Array.isArray(ids) || ids.length>1 || ids.some(id=>!/^\d{15,25}$/.test(id)))throw Error('Choose zero or one main caller.');this.id=ids[0] || null;this.available=false;this.channelId=null;this.absence=null;this.waited=null;}
 observe(channelId,ready,error=null){this.channelId=channelId || null;this.available=!!channelId && !!ready;this.followError=error;
 if(this.paused || this.available || !this.id || !this.startedWithMain){this.absence=null;this.waited=null;return;}
 if(!this.absence)this.absence={id:randomUUID(),since:this.now()};
 }
 pause(value){this.paused=value;this.absence=null;this.waited=null;}
 snapshot(){return{startedWithMain:this.startedWithMain,callerId:this.id,available:this.available,channelId:this.channelId,followError:this.followError,absenceId:this.absence?.id || null,unavailableSince:this.absence?.since || null,showReplacement:!this.paused && !!this.absence && this.now()-this.absence.since>=30000 && this.waited!==this.absence.id};}
 wait(id){if(!this.snapshot().showReplacement || id!==this.absence?.id){const error=Error('Main caller availability changed. Refresh and try again.');error.status=409;throw error;}this.waited=id;}
}
module.exports={MainCaller};
