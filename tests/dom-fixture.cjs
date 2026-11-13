// Minimal DOM fixture for testing tracking contracts without a browser binary.
class Element {
  constructor(tag, attrs={}, text='') {
    this.tagName=tag.toUpperCase(); this.attrs=attrs; this.ownText=text;
    this.children=[]; this.parentElement=null; this.value=''; this.dataset={};
    this.isContentEditable=false; this.complete=true; this.naturalWidth=512; this.naturalHeight=512;
    this.currentSrc=''; this.src=attrs.src || ''; this.isConnected=true;
  }
  get textContent(){return this.ownText+this.children.map(n=>n.textContent).join(' ');}
  get innerText(){return this.textContent;}
  getAttribute(k){return this.attrs[k] ?? null;}
  append(n){n.parentElement=this;n.isConnected=true;this.children.push(n);return n;}
  remove(){this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.isConnected=false;}
  matches(selector){
    return selector.split(',').some(s=>{
      s=s.trim(); const tag=s.match(/^[a-z]+/i)?.[0];
      if(tag&&tag.toUpperCase()!==this.tagName)return false;
      for(const match of s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if(!(match[1] in this.attrs))return false;
        if(match[2]!==undefined&&this.attrs[match[1]]!==match[2])return false;
      }
      return !!tag||s.startsWith('[');
    });
  }
  querySelectorAll(s){return this.children.flatMap(n=>[...(n.matches(s)?[n]:[]),...n.querySelectorAll(s)]);}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  closest(s){for(let n=this;n;n=n.parentElement)if(n.matches(s))return n;return null;}
  contains(other){return other===this||this.children.some(n=>n.contains(other));}
  getBoundingClientRect(){return {width:300,height:300,left:0,top:0};}
  getClientRects(){return [this.getBoundingClientRect()];}
  click(){} focus(){}
}
module.exports={Element};
