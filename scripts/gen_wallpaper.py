import random
import math

def generate_svg():
    width = 3840
    height = 2160
    
    # Colores base (Cyberpunk/Glass)
    bg_color = "#0f0f16"
    colors = [
        "#cba6f7", # Mauve (Purple)
        "#89b4fa", # Blue
        "#f5c2e7", # Pink
        "#74c7ec", # Sapphire
        "#b4befe", # Lavender
    ]
    
    svg = f'<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg" style="background-color:{bg_color}">'
    
    # Definir filtros para efecto cristal/glow
    svg += '''
    <defs>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="20" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#cba6f7;stop-opacity:0.2" />
            <stop offset="100%" style="stop-color:#89b4fa;stop-opacity:0.2" />
        </linearGradient>
    </defs>
    '''
    
    # 1. Background Gradient Mesh (formas grandes borrosas)
    for _ in range(5):
        cx = random.randint(0, width)
        cy = random.randint(0, height)
        r = random.randint(800, 1500)
        color = random.choice(colors)
        opacity = 0.15
        svg += f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}" opacity="{opacity}" filter="url(#glow)" />'

    # 2. Estructura de Cristal (Polígonos conectados)
    # Generar puntos centrales
    points = []
    for _ in range(20):
        x = random.randint(width//4, width*3//4)
        y = random.randint(height//4, height*3//4)
        points.append((x, y))
        
    # Dibujar conexiones (triángulos/líneas)
    for i in range(len(points)):
        p1 = points[i]
        # Conectar con 2 puntos cercanos
        sorted_points = sorted(points, key=lambda p: math.hypot(p[0]-p1[0], p[1]-p1[1]))
        
        for j in range(1, 4): # Conectar con los 3 más cercanos
            if j < len(sorted_points):
                p2 = sorted_points[j]
                p3 = sorted_points[(j+1)%len(sorted_points)]
                
                # Triángulo de cristal
                fill = random.choice(colors)
                fill_op = random.uniform(0.05, 0.2)
                
                svg += f'<polygon points="{p1[0]},{p1[1]} {p2[0]},{p2[1]} {p3[0]},{p3[1]}" fill="{fill}" opacity="{fill_op}" stroke="white" stroke-width="1" stroke-opacity="0.3" />'

    svg += '</svg>'
    
    with open("distroia_crystal.svg", "w") as f:
        f.write(svg)
        
    print("Wallpaper generado: distroia_crystal.svg")

if __name__ == "__main__":
    generate_svg()
