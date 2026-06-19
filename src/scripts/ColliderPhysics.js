/* ColliderPhysics.js: Handles concave decomposition and alignment */
export function createBodyForPart(part, Matter, decomp, GRID_SIZE = 20) {
    if (decomp && Matter?.Common?.setDecomp) Matter.Common.setDecomp(decomp);

    const editorColor = part.color || part.settings?.color || "#64748b";

    // Determine whether this part should be a sensor (gameplay flag)
    // Include fluid_sensor so sensors used for stopping/releasing marbles are created as sensors.
    const shouldBeSensor = !!(part.isSensor || part.sensor || ['spawn_point','teleporter','win_zone','fluid_sensor'].includes(part.type));

    const options = {
        isStatic: true,
        friction: 0.05,
        restitution: 0,
        label: part.type,
        plugin: { partId: part.id },
        render: { fillStyle: editorColor }
    };

    const anchorX = Number(part.x || 0);
    const anchorY = Number(part.y || 0);
    let body = null;

    if (part.type === 'circle') {
        body = Matter.Bodies.circle(anchorX, anchorY, part.radius || GRID_SIZE, options);
    } else if (Array.isArray(part.vertices) && part.vertices.length >= 3) {
        const relVerts = part.vertices.map(v => ({ x: v.x - anchorX, y: v.y - anchorY }));
        body = Matter.Bodies.fromVertices(anchorX, anchorY, [relVerts], options, true);

        if (!body) {
            body = Matter.Bodies.rectangle(anchorX, anchorY, part.width || GRID_SIZE * 2, part.height || GRID_SIZE, options);
        } else {
            // Fix vertex alignment for concave sub-parts
            try {
                const pts = part.vertices.map(v => ({ x: Number(v.x), y: Number(v.y) }));
                let minPx = Infinity, minPy = Infinity;
                pts.forEach(p => { minPx = Math.min(minPx, p.x); minPy = Math.min(minPy, p.y); });

                let minBx = Infinity, minBy = Infinity;
                const allParts = body.parts?.length > 1 ? body.parts.slice(1) : [body];
                allParts.forEach(p => p.vertices.forEach(v => { minBx = Math.min(minBx, v.x); minBy = Math.min(minBy, v.y); }));

                if (isFinite(minBx) && isFinite(minBy)) {
                    const dx = minPx - minBx, dy = minPy - minBy;
                    Matter.Body.translate(body, { x: dx, y: dy });
                    
                    // Propagate color and label to sub-parts
                    body.parts.forEach(p => {
                        p.render = p.render || {};
                        p.render.fillStyle = editorColor;
                        p.label = part.type;
                    });
                }
            } catch (err) {
                Matter.Body.setPosition(body, { x: anchorX, y: anchorY });
            }
        }
    } else {
        body = Matter.Bodies.rectangle(anchorX, anchorY, part.width || GRID_SIZE * 2, part.height || GRID_SIZE, options);
    }

    // Ensure sensor property is preserved and propagated to compound parts
    try {
        if (body) {
            // top-level body sensor flag
            body.isSensor = !!shouldBeSensor;
            // propagate to child parts for compound bodies so collision handlers see the flag on any part
            if (body.parts && body.parts.length > 1) {
                for (const child of body.parts) {
                    try {
                        child.isSensor = !!shouldBeSensor;
                        // also copy plugin.partId to child for consistent lookup
                        child.plugin = child.plugin || {};
                        child.plugin.partId = child.plugin.partId || part.id;
                        child.label = child.label || part.type;
                        child.render = child.render || {};
                        child.render.fillStyle = child.render.fillStyle || editorColor;
                    } catch (e) { /* ignore per-child failures */ }
                }
            } else {
                // single-part body: ensure plugin and render are set consistently
                body.plugin = body.plugin || {};
                body.plugin.partId = body.plugin.partId || part.id;
                body.render = body.render || {};
                body.render.fillStyle = body.render.fillStyle || editorColor;
            }
        }
    } catch (err) {
        // don't fail body creation if propagation fails
    }

    if (part.rotation) Matter.Body.setAngle(body, part.rotation);
    return body;
}