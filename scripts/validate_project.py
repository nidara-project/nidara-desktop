#!/usr/bin/env python3
import os
import subprocess
import sys

def check_file(path, label):
    if os.path.exists(path):
        print(f"✅ {label}: {path}")
        return True
    else:
        print(f"❌ {label} NO ENCONTRADO: {path}")
        return False

def check_command(cmd, label):
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print(f"✅ Comando {label} disponible")
        return True
    except:
        print(f"❌ Comando {label} NO disponible")
        return False

def validate_all():
    print("=== MiDistroIA Project Validator ===\n")
    all_ok = True

    # 1. Archivos Críticos
    all_ok &= check_file("ui/dock/main_dock.py", "Dock Logic")
    all_ok &= check_file("ui/dock/style.css", "Dock CSS")
    all_ok &= check_file("monitor.py", "Monitor Service")
    all_ok &= check_file("PROJECT_DNA.md", "Continuity Anchor")
    
    # 2. Comandos Requeridos
    all_ok &= check_command(["wmctrl", "-h"], "wmctrl (Posicionamiento X11)")
    all_ok &= check_command(["xprop", "-version"], "xprop (Hints X11)")
    all_ok &= check_command(["wofi", "--version"], "wofi (Lanzador)")
    
    # 3. Integración de Git
    try:
        res = subprocess.run(["git", "status"], capture_output=True, text=True)
        if "google-chrome-stable_current_amd64.deb" in res.stdout:
            print("⚠️ ADVERTENCIA: Binario pesado detectado en Git. Limpiar antes de push.")
        else:
            print("✅ Historial de Git limpio de binarios pesados.")
    except:
        print("❌ Error verificando Git")

    if all_ok:
        print("\n🚀 ESTADO DEL PROYECTO: LISTO PARA DESARROLLAR/CONSTRUIR")
    else:
        print("\n⚠️ EL PROYECTO TIENE ERRORES. NO CONSTRUIR ISO HASTA CORREGIR.")

if __name__ == "__main__":
    validate_all()
