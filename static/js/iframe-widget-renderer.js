// iframe-widget-renderer.js
// Renders widgets from HTML files in the zip file
// Widgets are loaded as blob URLs from the presentation zip

export function renderWidgets(slideConfig, container, getDisplayWidth, getDisplayHeight, zipFile) {
    if (!slideConfig.widgets || slideConfig.widgets.length === 0) {
        return;
    }

    console.log("Rendering", slideConfig.widgets.length, "widgets");
    
    slideConfig.widgets.forEach(async (w) => {
        const iframe = document.createElement("iframe");
        iframe.className = "widget-iframe";
        iframe.dataset.widgetId = w.id;
        
        // Styling
        iframe.style.position = "absolute";
        iframe.style.left = `${w.x * getDisplayWidth()}px`;
        iframe.style.top = `${w.y * getDisplayHeight()}px`;
        iframe.style.width = `${w.width * getDisplayWidth()}px`;
        iframe.style.height = `${w.height * getDisplayHeight()}px`;
        iframe.style.zIndex = w.zIndex || 10;
        iframe.style.border = "none";
        iframe.style.background = "transparent";
        iframe.style.pointerEvents = w.interactive !== false ? 'auto' : 'none';
        
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
                    config: w
                }, '*');
            });
            
        } catch (error) {
            console.error('Error loading widget:', error);
            iframe.srcdoc = `<div style="padding:20px;font-family:sans-serif;color:#e74c3c;">Error loading widget: ${error.message}</div>`;
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
