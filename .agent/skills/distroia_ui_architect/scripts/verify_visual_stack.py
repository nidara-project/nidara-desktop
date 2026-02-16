#!/usr/bin/env python3
import os
import subprocess
import json
import sys

# DistroIA Visual Stack Verifier
# Verifica conflictos comunes entre Hyprland y GTK LayerShell

def check_hyprland_rules():
    """Verifica si existen reglas de capa para evitar conflictos visuales."""
    try:
        # Obtenemos las capas actuales de Hyprland
        result = subprocess.run(['hyprctl', 'layers', '-j'], capture_output=True, text=True)
        layers = json.loads(result.stdout)
        
        print("[*] Analizando Namespaces de LayerShell activos...")
        namespaces = set()
        for monitor, data in layers.items():
            levels = data.get("levels", {})
            for level, windows in levels.items():
                for window in windows:
                    ns = window.get('namespace')
                    if ns:
                        namespaces.add(ns)
        
        print(f"    Namespaces encontrados: {', '.join(namespaces)}")
        
        # Verificamos si hay reglas de blur/ignorezero para estos namespaces
        config_path = os.path.expanduser("~/.config/hypr/hyprland.conf")
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                conf = f.read()
                print("\n[*] Verificando reglas de seguridad visual en hyprland.conf:")
                for ns in namespaces:
                    # Buscamos configuración básica de no-flicker
                    has_ignorezero = f"ignorezero, {ns}" in conf or f"ignorezero,{ns}" in conf
                    has_blur = f"blur, {ns}" in conf or f"blur,{ns}" in conf
                    
                    if not has_ignorezero:
                        print(f"    [ALERTA] El namespace '{ns}' no tiene 'ignorezero'.")
                        print(f"             Esto causará bordes negros en esquinas redondeadas.")
                    else:
                        print(f"    [OK] Namespace '{ns}' tiene ignorezero activado.")
                        
    except Exception as e:
        print(f"[!] Error conectando con Hyprland: {e}")

def check_gtk_env():
    """Verifica variables de entorno que afectan el renderizado."""
    print("\n[*] Verificando entorno GTK:")
    debug = os.environ.get('GTK_DEBUG')
    if debug:
        print(f"    [INFO] GTK_DEBUG está activo: {debug}")
    else:
        print("    [INFO] GTK_DEBUG no está activo (Correcto para producción).")
        
    # Verificar si estamos forzando backend
    gdk_backend = os.environ.get('GDK_BACKEND')
    print(f"    [INFO] GDK_BACKEND: {gdk_backend if gdk_backend else 'Auto (Wayland default)'}")

if __name__ == "__main__":
    print("=== DistroIA Visual Stack Analyzer ===")
    check_hyprland_rules()
    check_gtk_env()
    print("\n=== Análisis Completado ===")
