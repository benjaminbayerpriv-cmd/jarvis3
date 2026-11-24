#!/usr/bin/env python3
"""Lokaler Jarvis-Manager; keine zusätzlichen Python-Pakete erforderlich."""
import http.server, json, os, pathlib, secrets, shutil, socket, subprocess, sys, threading, time, urllib.request, webbrowser

ROOT = pathlib.Path(__file__).resolve().parents[2]
HOME = pathlib.Path.home() / '.jarvis3'
HOME.mkdir(exist_ok=True)
LOG = HOME / 'manager.log'
TOKEN = secrets.token_urlsafe(32)
proc = None
job = None
lock = threading.Lock()

def path_env():
    env = os.environ.copy()
    paths = [str(pathlib.Path.home()/'.bun/bin'), str(pathlib.Path.home()/'.opencode/bin'), str(pathlib.Path.home()/'.local/bin')]
    env['PATH'] = os.pathsep.join(paths + [env.get('PATH','')])
    return env

def find(name):
    return shutil.which(name, path=path_env()['PATH'])

def health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:7777/health', timeout=1) as r:
            return json.load(r)
    except Exception:
        return None

def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.5): return True
    except OSError: return False

def status():
    return {'health': health(), 'speech': port_open(7778), 'owned': proc is not None and proc.poll() is None,
            'job': job is not None and job.poll() is None, 'bun': bool(find('bun')), 'uv': bool(find('uv')),
            'opencode': bool(find('opencode')), 'root': str(ROOT)}

def start():
    global proc
    with lock:
        if health(): return 'Jarvis läuft bereits; die bestehende Instanz wird verwendet.'
        if port_open(7777): raise RuntimeError('Port 7777 ist belegt, aber dort antwortet kein Jarvis.')
        if proc and proc.poll() is None: return 'Jarvis startet bereits.'
        bun = find('bun')
        if not bun: raise RuntimeError('Bun fehlt. Bitte zuerst Voraussetzungen installieren.')
        log = open(LOG, 'a', encoding='utf-8')
        proc = subprocess.Popen([bun, 'run', str(ROOT/'core/src/index.ts')], cwd=ROOT, env=path_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=(os.name!='nt'), creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)
        log.close()
        return 'Jarvis wird gestartet. Der Sprachdienst benötigt eventuell Zeit zum Laden.'

def stop():
    global proc
    with lock:
        if not proc or proc.poll() is not None: raise RuntimeError('Diese Instanz wurde nicht vom Manager gestartet und wird nicht beendet.')
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait(timeout=5)
        return 'Der vom Manager gestartete Jarvis-Dienst wurde beendet.'

def install():
    global job
    with lock:
        if job and job.poll() is None: raise RuntimeError('Eine Installation läuft bereits.')
        env = path_env()
        bun, uv = find('bun'), find('uv')
        if not bun or not uv:
            missing = ', '.join(x for x,v in [('Bun',bun),('uv',uv)] if not v)
            raise RuntimeError(f'{missing} fehlt. Bitte zuerst gemäß README installieren; der Manager lädt keine ausführbaren Installationsskripte automatisch.')
        log = open(LOG,'a',encoding='utf-8')
        if os.name == 'nt':
            cmd = [os.environ.get('COMSPEC','cmd.exe'), '/d', '/c', f'"{bun}" install --cwd "{ROOT / "core"}" && "{uv}" sync --project "{ROOT / "speech"}"']
        else:
            cmd = ['/bin/sh','-c','"$1" install --cwd "$2/core" && "$3" sync --project "$2/speech"','sh',bun,str(ROOT),uv]
        job = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        log.close()
        return 'Installation gestartet. Fortschritt und Fehler stehen im Protokoll.'

def logs():
    items=[]
    for title, p in [('Manager und Jarvis',LOG),('Sprache',HOME/'sidecar.log'),('Sprachablauf',HOME/'voice.log')]:
        try:
            with p.open('rb') as f:
                f.seek(0,2); f.seek(max(0,f.tell()-40000)); data=f.read().decode('utf-8','replace')
            items.append('── '+title+' ──\n'+data[-25000:])
        except OSError: pass
    return '\n\n'.join(items) or 'Noch keine Protokolle vorhanden.'

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self, status, body, typ='application/json; charset=utf-8'):
        data=body if isinstance(body,bytes) else json.dumps(body,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type',typ); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == '/': self.reply(200,(pathlib.Path(__file__).parent/'index.html').read_bytes(),'text/html; charset=utf-8')
        elif self.path == '/api/status': self.reply(200,status())
        elif self.path == '/api/logs': self.reply(200,{'text':logs()})
        elif self.path == '/api/token': self.reply(200,{'token':TOKEN})
        else: self.reply(404,{'error':'Nicht gefunden'})
    def do_POST(self):
        if self.headers.get('Origin') != f'http://127.0.0.1:{self.server.server_port}' or self.headers.get('X-Jarvis-Token') != TOKEN:
            return self.reply(403,{'error':'Nicht erlaubt'})
        try:
            actions={'/api/start':start,'/api/stop':stop,'/api/install':install}
            if self.path not in actions: return self.reply(404,{'error':'Nicht gefunden'})
            self.reply(200,{'message':actions[self.path]()})
        except Exception as e: self.reply(400,{'error':str(e)})

def terminal_ui(url):
    """ANSI terminal UI with xterm SGR and legacy mouse reporting."""
    import select, termios, tty
    fd = sys.stdin.fileno()
    if not os.isatty(fd) or not sys.stdout.isatty():
        raise RuntimeError('Ein interaktives Terminal ist erforderlich.')
    previous = termios.tcgetattr(fd)
    notice = 'Klicken oder Pfeiltasten und Eingabe verwenden.'
    selected = 0
    log_offset = 0
    view = 'dashboard'
    click_targets = []
    buttons = [('Starten', start), ('Beenden', stop), ('Jarvis öffnen', lambda: webbrowser.open('http://127.0.0.1:7777/app/')), ('Installieren', install), ('Web-Manager', lambda: webbrowser.open(url)), ('Protokolle', None), ('Schließen', None)]
    buffer = b''
    def draw():
        nonlocal click_targets
        size = shutil.get_terminal_size((100, 30)); width, height = size.columns, size.lines
        click_targets = []
        def row(y, text='', color=''):
            if 1 <= y <= height:
                text = text.replace('\x1b', '?').replace('\r', ' ').replace('\t', '    ')
                sys.stdout.write(f'\x1b[{y};1H\x1b[2K{color}{text[:max(0,width-1)]}\x1b[0m')
        s = status()
        sys.stdout.write('\x1b[H\x1b[2J')
        row(1, '  J A R V I S   /   MANAGER', '\x1b[1;94m')
        row(2, '  ' + '─' * max(1, min(width-4, 90)), '\x1b[90m')
        row(3, '  Jarvis: ' + ('läuft' if s['health'] else 'nicht erreichbar') + '   ·   Sprache: ' + ('bereit' if s['speech'] else 'nicht bereit') + ('   ·   Installation läuft' if s['job'] else ''))
        row(4, '  Bun: ' + ('bereit' if s['bun'] else 'fehlt') + '   ·   uv: ' + ('bereit' if s['uv'] else 'fehlt') + '   ·   OpenCode: ' + ('bereit' if s['opencode'] else 'fehlt'), '\x1b[90m')
        x,y=3,6
        for i,(label,_) in enumerate(buttons):
            text='[ '+label+' ]'
            if x + len(text) >= width: x=3; y+=2
            if y < height-4:
                sys.stdout.write(f'\x1b[{y};{x}H' + ('\x1b[30;104m' if i==selected else '\x1b[36m') + text + '\x1b[0m')
                click_targets.append((y,x,x+len(text)-1,i))
            x += len(text)+2
        row(y+2, '  '+notice, '\x1b[93m')
        if view == 'logs':
            row(y+4, '  PROTOKOLLE  ·  ↑/↓ oder Mausrad zum Blättern', '\x1b[1m')
            lines = logs().splitlines(); area = max(0,height-y-6)
            end = max(0,len(lines)-log_offset); start_at=max(0,end-area)
            for line_num,line in enumerate(lines[start_at:end]): row(y+5+line_num,'  '+line)
        else:
            row(y+4, '  Startet und überwacht deinen lokalen Jarvis.', '\x1b[90m')
            row(y+5, '  Installation lädt bei Bedarf Abhängigkeiten herunter.', '\x1b[90m')
            row(y+7, '  Web-Manager: '+url, '\x1b[90m')
        row(height, '  Maus: klicken  ·  Tastatur: ←/→ + Enter  ·  Q: schließen', '\x1b[90m')
        sys.stdout.flush()
    def activate(i):
        nonlocal notice, view, log_offset
        label,fn = buttons[i]
        if label == 'Schließen': return False
        if label == 'Protokolle': view = 'dashboard' if view == 'logs' else 'logs'; log_offset=0
        else:
            try:
                result=fn()
                notice = result if isinstance(result,str) else ('Im Browser geöffnet.' if result else 'Browser konnte nicht geöffnet werden.')
            except Exception as e: notice=str(e)
        return True
    def mouse(button,x,y):
        nonlocal selected,log_offset
        if button & 64:
            if view == 'logs': log_offset=max(0,log_offset+(3 if (button & 1)==0 else -3))
            return True
        if button & 3: return True
        for cy,x1,x2,i in click_targets:
            if y==cy and x1<=x<=x2: selected=i; return activate(i)
        return True
    try:
        tty.setcbreak(fd)
        sys.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'); sys.stdout.flush()
        running=True; last=0
        while running:
            if time.monotonic()-last>2:
                draw(); last=time.monotonic()
            ready,_,_=select.select([fd],[],[],.1)
            if not ready: continue
            buffer += os.read(fd,1024)
            while buffer:
                if buffer.startswith(b'\x1b[<'):
                    import re
                    match=re.match(rb'\x1b\[<(\d+);(\d+);(\d+)([Mm])',buffer)
                    if not match: break
                    button,x,y=map(int,match.groups()[:3]); buffer=buffer[match.end():]
                    if match.group(4)==b'M': running=mouse(button,x,y)
                elif buffer.startswith(b'\x1b[M'):
                    if len(buffer)<6: break
                    running=mouse(buffer[3]-32,buffer[4]-32,buffer[5]-32); buffer=buffer[6:]
                elif buffer.startswith(b'\x1b['):
                    if len(buffer)<3: break
                    key=buffer[2]; buffer=buffer[3:]
                    if key in (67,66):
                        if key==66 and view=='logs': log_offset=max(0,log_offset-3)
                        else: selected=(selected+1)%len(buttons)
                    elif key in (68,65):
                        if key==65 and view=='logs': log_offset+=3
                        else: selected=(selected-1)%len(buttons)
                else:
                    key=buffer[:1]; buffer=buffer[1:]
                    if key in (b'q',b'Q',b'\x03'): running=False
                    elif key in (b'\r',b'\n'): running=activate(selected)
                if not running: break
            draw(); last=time.monotonic()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, previous)
        sys.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'); sys.stdout.flush()

def windows_ui(url):
    while True:
        os.system('cls')
        s=status()
        print('JARVIS MANAGER\n')
        print('Jarvis:', 'läuft' if s['health'] else 'nicht erreichbar', '| Sprache:', 'bereit' if s['speech'] else 'nicht bereit')
        print('\n1 Starten  2 Beenden  3 Jarvis öffnen  4 Installieren  5 Web-Manager  6 Protokolle  0 Schließen')
        choice=input('Auswahl: ').strip()
        if choice=='0': break
        actions={'1':start,'2':stop,'3':lambda:webbrowser.open('http://127.0.0.1:7777/app/'),'4':install,'5':lambda:webbrowser.open(url),'6':logs}
        try: print(actions[choice]())
        except Exception as e: print(e)
        input('Eingabetaste zum Fortfahren …')

def main():
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    url=f'http://127.0.0.1:{server.server_port}/'
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        if os.name == 'nt': windows_ui(url)
        else: terminal_ui(url)
    finally: server.shutdown(); server.server_close()
if __name__=='__main__': main()
