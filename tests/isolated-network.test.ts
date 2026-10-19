import {describe,it,expect} from 'vitest';
import {validateIsolatedNetwork} from '../apps/runner/src/environment-v2.js';
const valid = () => ({Driver:'bridge',Internal:true,EnableIPv6:false,
  Options:{'com.docker.network.bridge.gateway_mode_ipv4':'isolated'},IPAM:{Config:[{Subnet:'172.20.0.0/16'}]}});
describe('actual execution network admission',()=>{
  it('accepts an inspected isolated bridge without a gateway',()=>expect(()=>validateIsolatedNetwork(valid())).not.toThrow());
  it.each([
    ['non-internal',{Internal:false}],['ipv6',{EnableIPv6:true}],['wrong driver',{Driver:'host'}],
    ['silently ignored option',{Options:{}}],['default nat',{Options:{'com.docker.network.bridge.gateway_mode_ipv4':'nat'}}],
    ['unexpected gateway',{IPAM:{Config:[{Subnet:'172.20.0.0/16',Gateway:'172.20.0.1'}]}}],
    ['missing IPAM',{IPAM:{}}],['empty IPAM',{IPAM:{Config:[]}}],
  ])('rejects %s before containers join',(_name,override)=>{
    expect(()=>validateIsolatedNetwork({...valid(),...override})).toThrow('ISOLATED_NETWORK_REQUIRED');
  });
});
