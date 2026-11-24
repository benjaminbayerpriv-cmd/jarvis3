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

def main():
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    url=f'http://127.0.0.1:{server.server_port}/'
    threading.Thread(target=server.serve_forever,daemon=True).start()
    # Tk ist auf den meisten Rechnern vorhanden; falls nicht, ist dieselbe Oberfläche im Browser nutzbar.
    try:
        import tkinter as tk
        from tkinter import scrolledtext
        app=tk.Tk(); app.title('Jarvis Manager'); app.geometry('860x650')
        title=tk.Label(app,text='Jarvis Manager',font=('Arial',22,'bold')); title.pack(pady=(18,4))
        state=tk.Label(app,text='Status wird geladen …'); state.pack(pady=5)
        notice=tk.Label(app,text='',wraplength=800); notice.pack(pady=4)
        row=tk.Frame(app); row.pack(pady=8)
        output=scrolledtext.ScrolledText(app,wrap='word',height=20); output.pack(fill='both',expand=True,padx=18,pady=12)
        def run_action(fn):
            def work():
                try: text=fn()
                except Exception as e: text=str(e)
                app.after(0,lambda:notice.config(text=text))
            threading.Thread(target=work,daemon=True).start()
        def refresh_logs():
            output.delete('1.0','end'); output.insert('end',logs()); output.see('end')
        for label, fn in [('Starten',lambda:run_action(start)),('Beenden',lambda:run_action(stop)),('Jarvis öffnen',lambda:webbrowser.open('http://127.0.0.1:7777/app/')),('Voraussetzungen installieren',lambda:run_action(install)),('Web-Manager',lambda:webbrowser.open(url)),('Protokoll aktualisieren',refresh_logs)]: tk.Button(row,text=label,command=fn).pack(side='left',padx=2)
        def refresh():
            def work():
                s=status(); text=('Jarvis: läuft' if s['health'] else 'Jarvis: aus')+('  ·  Sprache: bereit' if s['speech'] else '  ·  Sprache: nicht bereit')+('  ·  Installation läuft' if s['job'] else '')
                try: app.after(0,lambda:state.config(text=text))
                except RuntimeError: pass
            threading.Thread(target=work,daemon=True).start(); app.after(3000,refresh)
        refresh_logs(); refresh(); app.mainloop()
    except (ImportError, Exception) as e:
        print('Grafisches Fenster nicht verfügbar:',e); print('Manager im Browser:',url); webbrowser.open(url)
        try: threading.Event().wait()
        except KeyboardInterrupt: pass
    finally: server.shutdown(); server.server_close()
if __name__=='__main__': main()
