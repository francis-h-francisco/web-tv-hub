(function(){var b=document.body,D=JSON.parse(b.getAttribute('data-d')),up=b.getAttribute('data-up'),now=Date.now();
var t=function(ms){return new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})},d=function(ms){return new Date(ms).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})};
var pill=document.getElementById('pill'),when=document.getElementById('when'),go=document.getElementById('go');
if(D.s==null)return;
if(now>=D.e){pill.textContent='This show has ended';when.textContent='It aired on '+D.name+' '+d(D.s)+', '+t(D.s)+'.';go.textContent='▶ See what is on '+D.name+' now';}
else if(now>=D.s){pill.textContent='● Live now';pill.className='p live';when.textContent='On '+D.name+' until '+t(D.e);}
else{pill.textContent='Coming up · '+d(D.s)+', '+t(D.s);pill.className='p next';when.textContent='On '+D.name+' · starts in '+Math.max(1,Math.round((D.s-now)/60000))+' min';
go.textContent='🔔 Remind me · watch on '+D.name;go.href=up+'?ch='+encodeURIComponent(D.ch)+'&remind='+D.s;}})();