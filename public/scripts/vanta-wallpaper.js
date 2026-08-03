// In life, it is important to embrace the fancy

(function () {
    var attempts = 0;
    var maxAttempts = 100;

    function initialize() {
        var target = document.getElementById("SITE_BACKGROUND");
        if (!target || target.getAttribute("data-vanta-initialized") === "true") {
            return;
        }

        if (!window.VANTA || !window.THREE || !window.VANTA.GLOBE) {
            attempts += 1;
            if (attempts < maxAttempts) {
                window.setTimeout(initialize, 50);
            }
            return;
        }

        window.VANTA.GLOBE({
            el: "#SITE_BACKGROUND",
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.00,
            minWidth: 200.00,
            scale: 1.00,
            scaleMobile: 1.00,
            color: 0xffffff,
            color2: 0x395cff,
            backgroundColor: 0x0
        });

        target.setAttribute("data-vanta-initialized", "true");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();
