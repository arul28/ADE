#!/usr/bin/env python3
"""Minimal Agent 37 API client for the codegen benchmark. Reads AGENT37_API_KEY from the environment.

  agent37.py create <template> <name> <default|vm|performance> <cpu> <memGB> <diskGB>
  agent37.py exec <id> '<shell command>'
  agent37.py get|delete <id>
  agent37.py list
  agent37.py post </instances/<id>/sleep|start|fork> ['<json body>']
"""
import json, os, sys, time, urllib.error, urllib.request

API = 'https://api.agent37.com/v1'
SANDBOX = 'https://sandbox.agent37.app/v1'


def key():
    value = os.environ.get('AGENT37_API_KEY', '').strip()
    if not value:
        raise SystemExit('Set AGENT37_API_KEY (ade secrets get AGENT37_API_KEY --text).')
    return value


def call(method, url, body=None, timeout=600, sandbox=False):
    headers = {'accept': 'application/json'}
    headers['x-agent37-key' if sandbox else 'authorization'] = key() if sandbox else 'Bearer ' + key()
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['content-type'] = 'application/json'
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors='ignore')


def exec_on(instance, command, timeout=600):
    status, body = call('POST', f'{SANDBOX}/instances/{instance}/exec', {'command': command}, timeout=timeout, sandbox=True)
    return body if isinstance(body, dict) else {'exit_code': -1, 'stdout': '', 'stderr': str(body)}


def status_of(instance):
    status, body = call('GET', f'{API}/instances/{instance}')
    return body.get('status') if isinstance(body, dict) else f'http {status}'


def main():
    command, args = sys.argv[1], sys.argv[2:]
    started = time.time()
    if command == 'create':
        template, name, kind, cpu, memory, disk = args[:6]
        status, body = call('POST', API + '/instances', {
            'template': template, 'name': name, 'type': kind, 'auto_sleep': False,
            'resources': {'cpu': int(cpu), 'memory': int(memory), 'disk': int(disk)}})
    elif command == 'exec':
        result = exec_on(args[0], args[1])
        sys.stdout.write(result.get('stdout', ''))
        sys.stderr.write(result.get('stderr', ''))
        print(f'[exit {result.get("exit_code")} in {time.time() - started:.2f}s]', file=sys.stderr)
        return
    elif command in ('get', 'delete'):
        status, body = call('GET' if command == 'get' else 'DELETE', f'{API}/instances/{args[0]}')
    elif command == 'list':
        status, body = call('GET', API + '/instances')
    elif command == 'post':
        status, body = call('POST', API + args[0], json.loads(args[1]) if len(args) > 1 else {})
    else:
        raise SystemExit(__doc__)
    print(json.dumps({'status': status, 'secs': round(time.time() - started, 2), 'body': body}, indent=1))


if __name__ == '__main__':
    main()
