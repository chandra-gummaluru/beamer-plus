// iframe-widget-renderer.js
// Renders widgets from HTML files in the zip file
// Widgets are loaded as blob URLs from the presentation zip

export function renderWidgets(slideConfig, container, zipFile, isViewer) {
    if (!slideConfig.widgets || slideConfig.widgets.length === 0) {
        return;
    }

    console.log("Rendering", slideConfig.widgets.length, "widgets");
    
    slideConfig.widgets.forEach(async (w) => {
        const iframe = document.createElement("iframe");
        iframe.className = "widget-iframe";
        iframe.dataset.widgetId = w.id;
        
        // Store original widget config as percentages (0-1 range) for resize handling
        iframe.dataset.widgetX = w.x;
        iframe.dataset.widgetY = w.y;
        iframe.dataset.widgetWidth = w.width;
        iframe.dataset.widgetHeight = w.height;
        iframe.dataset.widgetZIndex = w.zIndex || 10;
        iframe.dataset.widgetInteractive = w.interactive !== false ? 'true' : 'false';
        
        // Get container's actual size
        const rect = container.getBoundingClientRect();
        
        // Styling - position relative to container's actual size
        iframe.style.position = "absolute";
        iframe.style.left = `${w.x * rect.width}px`;
        iframe.style.top = `${w.y * rect.height}px`;
        iframe.style.width = `${w.width * rect.width}px`;
        iframe.style.height = `${w.height * rect.height}px`;
        iframe.style.zIndex = w.zIndex || 10;
        iframe.style.border = "none";
        iframe.style.background = "transparent";
        iframe.style.pointerEvents = w.interactive !== false ? 'auto' : 'none';

        if (isViewer) {
            iframe.style.pointerEvents = "none";
        }
        
        iframe.allow = "autoplay; fullscreen";
        
        container.appendChild(iframe);
        
        // Load widget HTML from zip
        try {
            // Get the widget HTML file from zip
            const widgetPath = w.src || `widgets/${w.type}.html`;
            const widgetFile = zipFile.file(widgetPath);
            
            if (!widgetFile) {
                console.error(`Widget file not found in zip: ${widgetPath}`);
                iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#666;">Widget not found: ${widgetPath}</div>`;
                return;
            }
            
            const htmlContent = await widgetFile.async("string");
            
            // Set the iframe content directly
            iframe.srcdoc = htmlContent;
            
            // Pass config to widget once loaded
            iframe.addEventListener('load', () => {
                iframe.contentWindow.postMessage({
                type: 'widget-config',
                config: {
                    ...w,
                    role: isViewer ? 'viewer' : 'presenter'
                }
            }, '*');
            });
            
        } catch (error) {
            console.error('Error loading widget:', error);
            iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#e74c3c;">Error loading widget: ${error.message}</div>`;
        }
    });
}

export function updateWidgetPositions(container) {
    // Update positions and sizes of all widgets after resize
    // Use the container's actual bounding rect for accurate positioning
    const rect = container.getBoundingClientRect();
    const widgets = container.querySelectorAll('.widget-iframe');
    
    widgets.forEach(iframe => {
        const x = parseFloat(iframe.dataset.widgetX);
        const y = parseFloat(iframe.dataset.widgetY);
        const width = parseFloat(iframe.dataset.widgetWidth);
        const height = parseFloat(iframe.dataset.widgetHeight);
        
        if (!isNaN(x) && !isNaN(y) && !isNaN(width) && !isNaN(height)) {
            iframe.style.left = `${x * rect.width}px`;
            iframe.style.top = `${y * rect.height}px`;
            iframe.style.width = `${width * rect.width}px`;
            iframe.style.height = `${height * rect.height}px`;
        }
    });
}

export function cleanupWidgets(container) {
    const existingWidgets = container.querySelectorAll('.widget-iframe');
    existingWidgets.forEach(iframe => {
        // Send cleanup message to iframe
        if (iframe.contentWindow) {
            try {
                iframe.contentWindow.postMessage({ type: 'widget-cleanup' }, '*');
            } catch (e) {
                // Ignore errors if iframe is already destroyed
            }
        }
        iframe.remove();
    });
}