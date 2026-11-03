#!/usr/bin/env python3
"""Pull and verify project backups. No credentials are accepted on the command line."""
import argparse, datetime, hashlib, json, os, pathlib, shutil, subprocess, tarfile, tempfile
p=argparse.ArgumentParser()
p.add_argument('--ssh-wrapper',required=True)
p.add_argument('--destination',required=True)
a=p.parse_args()
os.umask(0o077)
dest=pathlib.Path(a.destination).expanduser();dest.mkdir(parents=True,exist_ok=True,mode=0o700)
remote='/opt/apps/telegram-job-alerts'
with tempfile.TemporaryDirectory(prefix='.pull-',dir=dest) as temporary:
 stage=pathlib.Path(temporary);archive=stage/'transfer.tgz'
 with archive.open('wb') as output:
  subprocess.run([a.ssh_wrapper,'--',f'cd {remote} && tar -czf - backups state/deletions.jsonl'],stdout=output,check=True,timeout=300)
 with tarfile.open(archive,'r:gz') as data:
  for member in data.getmembers():
   path=pathlib.PurePosixPath(member.name)
   if path.is_absolute() or '..' in path.parts or path.parts[0] not in ('backups','state') or not(member.isfile() or member.isdir()):raise ValueError('Unsafe backup archive member')
   data.extract(member,path=stage)
 dumps=list((stage/'backups').glob('*.dump'))
 if not dumps:raise ValueError('No database backup available')
 for dump in dumps:
  expected=dump.with_suffix('.dump.sha256').read_text().split()[0]
  actual=hashlib.sha256(dump.read_bytes()).hexdigest()
  if actual!=expected:raise ValueError('Backup checksum mismatch')
 for folder in ('backups','state'):
  target=dest/folder;target.mkdir(exist_ok=True,mode=0o700)
  for source in (stage/folder).iterdir():
   if not source.is_file():raise ValueError('Unexpected backup directory')
   shutil.copy2(source,target/source.name);os.chmod(target/source.name,0o600)
 cutoff=datetime.datetime.now().timestamp()-14*86400
 for file in (dest/'backups').iterdir():
  if file.is_file() and file.stat().st_mtime<cutoff:file.unlink()
 # Only the project's dedicated backups directory is eligible for remote retention.
 subprocess.run([a.ssh_wrapper,'--',f'find {remote}/backups -maxdepth 1 -type f -mtime +14 -delete'],check=True,timeout=30)
 state={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verifiedDumps':len(dumps),'latestDump':max(d.name for d in dumps)}
 (dest/'last-success.json').write_text(json.dumps(state)+'\n')
 print(json.dumps(state))
