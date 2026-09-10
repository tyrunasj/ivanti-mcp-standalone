import { describe, expect, it } from 'vitest';
import { describeRpc } from './describe-rpc.js';

describe('describeRpc', () => {
  it('reports the JSON-RPC method', () => {
    expect(describeRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({
      rpcMethod: 'tools/list',
    });
  });

  it('reports the tool name for tools/call', () => {
    const summary = describeRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_version', arguments: { secret: 'do not log me' } },
    });

    expect(summary).toEqual({ rpcMethod: 'tools/call', tool: 'get_version' });
  });

  it('never includes arguments, which carry ticket contents and personal data', () => {
    const summary = describeRpc({
      method: 'tools/call',
      params: { name: 'create_record', arguments: { Subject: 'my password is hunter2' } },
    });

    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  it('counts a batch and summarises its first message', () => {
    const summary = describeRpc([{ method: 'tools/list' }, { method: 'tools/call' }]);

    expect(summary).toEqual({ rpcMethod: 'tools/list', batch: 2 });
  });

  it('tolerates a body that is not an object', () => {
    expect(describeRpc(undefined)).toEqual({});
    expect(describeRpc('nonsense')).toEqual({});
    expect(describeRpc(null)).toEqual({});
  });

  it('omits the tool for a method that is not tools/call', () => {
    expect(describeRpc({ method: 'initialize', params: { name: 'x' } })).toEqual({
      rpcMethod: 'initialize',
    });
  });
});
