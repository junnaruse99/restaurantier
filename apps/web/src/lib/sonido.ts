"use client";

let contexto: AudioContext | undefined;

/** Pitido corto para avisos (comanda nueva en el KDS, plato listo para el mozo). */
export function pitido(frecuencia = 880, duracionMs = 180): void {
  try {
    contexto ??= new AudioContext();
    const oscilador = contexto.createOscillator();
    const volumen = contexto.createGain();
    oscilador.frequency.value = frecuencia;
    volumen.gain.value = 0.15;
    oscilador.connect(volumen).connect(contexto.destination);
    oscilador.start();
    oscilador.stop(contexto.currentTime + duracionMs / 1000);
  } catch {
    // Sin audio (navegador sin permiso o sin interacción previa): el aviso visual basta.
  }
}
