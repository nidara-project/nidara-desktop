# Arquitectura de Inteligencia Local (AI Stack)

Crystal Shell se diferencia por integrar IA generativa como un **servicio nativo del sistema operativo**, no como una aplicación externa.

## 1. El Motor: Ollama (System Daemon)
Usamos **Ollama** por su eficiencia, soporte de hardware y API sencilla.
- **Implementación**: Debe correr como un servicio de `systemd` a nivel de usuario o sistema, listo en segundo plano.
- **Unidad Systemd (`/etc/systemd/system/ollama.service`)**:
  ```ini
  [Unit]
  Description=Ollama Service
  After=network-online.target

  [Service]
  ExecStart=/usr/bin/ollama serve
  User=ollama
  Group=ollama
  Restart=always
  RestartSec=3
  Environment="OLLAMA_HOST=127.0.0.1:11434"
  # Aceleración GPU (Auto-detectada por Ollama, pero forzable aquí si es necesario)

  [Install]
  WantedBy=multi-user.target
  ```

## 2. Modelos por Defecto
La ISO debe incluir (o descargar en el primer arranque) modelos optimizados:
- **Chat General**: `llama3` o `mistral` (versiones cuantizadas 4-bit para bajo consumo de RAM).
- **Coding/Sistema**: `deepseek-coder` para asistencia técnica ligera.
- **Ubicación**: Los modelos viven en `/usr/share/ollama/.ollama` (pre-instalados) o `~/.ollama` (usuario).

## 3. Integración con la UI (AGS)
La interfaz no debe tener "lógica de IA", solo consumir la API.
- **Endpoint**: `http://127.0.0.1:11434/api/generate` (o `/chat`).
- **Servicio AGS**: Crear un `Service` en Astal que haga `fetch` asíncrono a este endpoint y emita señales con la respuesta streaming.
- **UX**:
  - `Super + A`: Abre un "Spotlight" flotante para preguntas rápidas.
  - **Contexto**: El servicio puede inyectar contexto del sistema (ej. contenido del portapapeles o ventana activa) en el prompt.

## 4. Hardware Acceleration
- **Nvidia**: Requiere drivers propietarios + CUDA container toolkit (si se usa Docker) o librerías nativas.
- **AMD**: ROCm.
- **CPU Fallback**: AVX/AVX2. Imprescindible verificar soporte en la instalación.
