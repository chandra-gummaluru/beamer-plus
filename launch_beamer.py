#!/usr/bin/env python3
"""
Beamer+ Launcher with QR Code
Starts the Flask app and displays a QR code for easy mobile access
"""

import os
import sys
import socket
import subprocess
import threading
import time

# Colors for terminal output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def print_header(text):
    print(f"\n{Colors.BOLD}{Colors.CYAN}{text}{Colors.ENDC}")

def print_success(text):
    print(f"{Colors.GREEN}✅ {text}{Colors.ENDC}")

def print_info(text):
    print(f"{Colors.BLUE}ℹ️  {text}{Colors.ENDC}")

def print_error(text):
    print(f"{Colors.RED}❌ {text}{Colors.ENDC}")

def print_warning(text):
    print(f"{Colors.YELLOW}⚠️  {text}{Colors.ENDC}")

def get_local_ip():
    """Get the local network IP address"""
    try:
        # Create a socket to determine the local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        try:
            # Connect to an external IP (doesn't actually send data)
            s.connect(('10.254.254.254', 1))
            ip = s.getsockname()[0]
        except Exception:
            ip = '127.0.0.1'
        finally:
            s.close()
        return ip
    except Exception:
        return '127.0.0.1'

def generate_qr_ascii(data):
    """Generate ASCII QR code using qrcode library"""
    try:
        import qrcode
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_L,
            box_size=1,
            border=1,
        )
        qr.add_data(data)
        qr.make(fit=True)
        
        # Generate ASCII art
        qr.print_ascii(invert=True)
        return True
    except ImportError:
        return False

def install_qrcode():
    """Try to install qrcode library"""
    print_info("Installing qrcode library...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "qrcode[pil]"])
        print_success("qrcode library installed successfully")
        return True
    except subprocess.CalledProcessError:
        print_error("Failed to install qrcode library")
        return False

def check_dependencies():
    """Check and install required dependencies"""
    print_header("📋 Checking dependencies...")
    
    # Check Flask
    try:
        import flask
        print_success("Flask is installed")
    except ImportError:
        print_warning("Flask not found. Installing...")
        try:
            if os.path.exists("requirements.txt"):
                subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
            else:
                subprocess.check_call([sys.executable, "-m", "pip", "install", "flask"])
            print_success("Flask installed successfully")
        except subprocess.CalledProcessError:
            print_error("Failed to install Flask")
            sys.exit(1)
    
    # Check qrcode
    try:
        import qrcode
        return True
    except ImportError:
        print_warning("qrcode library not found")
        response = input("Would you like to install it? (y/n): ").lower().strip()
        if response == 'y':
            return install_qrcode()
        else:
            print_info("Continuing without QR code display")
            return False

def display_info(url, local_ip, port, has_qr=True):
    """Display connection information"""
    print_header("📱 Access your Beamer+ app at:")
    print()
    print(f"   {Colors.BOLD}Local:{Colors.ENDC}   http://localhost:{port}")
    
    if local_ip != '127.0.0.1':
        print(f"   {Colors.BOLD}Network:{Colors.ENDC} {url}")
        print()
        print_info("The network URL can be accessed by any device on the same WiFi/network")
    else:
        print()
        print_info("Network access not available (no network IP detected)")
    
    print()
    
    if has_qr and local_ip != '127.0.0.1':
        print_header("📲 Scan this QR code with your phone:")
        print()
        if not generate_qr_ascii(url):
            print_warning("Could not generate QR code")
            print(f"   Please enter this URL manually: {url}")
        print()
        print(f"   (QR code contains: {url})")
        print()

def main():
    """Main launcher function"""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*50}")
    print("🚀 Beamer+ Launcher")
    print(f"{'='*50}{Colors.ENDC}\n")
    
    # Check if app.py exists
    if not os.path.exists("app.py"):
        print_error("app.py not found in current directory")
        print("Please run this script from the beamer-plus-demo directory")
        sys.exit(1)
    
    # Check dependencies
    has_qr = check_dependencies()
    
    # Get network information
    print_header("🔍 Detecting network configuration...")
    local_ip = get_local_ip()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    
    if local_ip == '127.0.0.1':
        url = f"http://localhost:{port}"
        print_warning("Could not detect network IP, using localhost only")
    else:
        url = f"http://{local_ip}:{port}"
        print_success(f"IP Address: {local_ip}")
    
    print_success(f"Port: {port}")
    print()
    
    # Display connection info
    display_info(url, local_ip, port, has_qr)
    
    # Instructions
    print(f"{Colors.BOLD}{'━'*50}")
    print("🎯 Instructions:")
    print("   • Make sure your phone/device is on the same WiFi network")
    print("   • Scan the QR code above OR enter the URL manually")
    print("   • Press Ctrl+C to stop the server")
    print(f"{'━'*50}{Colors.ENDC}\n")
    
    # Start the Flask app
    print_header("🚀 Starting Beamer+ server...")
    print()
    
    try:
        # Import and run the Flask app
        from app import app
        print(f"{Colors.GREEN}Server is running! Press Ctrl+C to quit.{Colors.ENDC}\n")
        app.run(host='0.0.0.0', port=port, debug=False)
    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}👋 Server stopped. Goodbye!{Colors.ENDC}\n")
        sys.exit(0)
    except Exception as e:
        print_error(f"Failed to start server: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
