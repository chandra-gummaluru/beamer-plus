#!/usr/bin/env python3
"""
Beamer+ Launcher
Starts the Flask app and displays connection information
"""

import os
import sys
import socket
import subprocess
import argparse

# Colors for terminal output
class Colors:
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
    print(f"{Colors.GREEN}{text}{Colors.ENDC}")

def print_info(text):
    # ASCII only: non-ASCII output crashes on Windows consoles using cp1252
    print(f"{Colors.BLUE}{text}{Colors.ENDC}")

def print_error(text):
    print(f"{Colors.RED}{text}{Colors.ENDC}")

def print_warning(text):
    print(f"{Colors.YELLOW}{text}{Colors.ENDC}")

def get_lan_ip():
    """Get the LAN IP address"""
    try:
        # Create a socket to determine the local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        try:
            # Connect to an external IP (doesn't actually send data)
            s.connect(('10.254.254.254', 1))
            lan_ip = s.getsockname()[0]
            if lan_ip != '127.0.0.1':
                return lan_ip
        except Exception:
            pass
        finally:
            s.close()
    except Exception:
        pass
    
    return None

def generate_self_signed_cert(lan_ip=None):
    """Generate a self-signed SSL certificate with localhost/LAN-IP SANs"""
    cert_file = "cert.pem"
    key_file = "key.pem"

    # Check if certificate already exists (delete cert.pem/key.pem to force
    # regeneration, e.g. after it expires or your LAN IP changes)
    if os.path.exists(cert_file) and os.path.exists(key_file):
        print_success("SSL certificate already exists")
        return cert_file, key_file

    print_info("Generating self-signed SSL certificate...")

    try:
        import datetime
        import ipaddress
        try:
            from cryptography import x509
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import rsa
            from cryptography.x509.oid import NameOID
        except ImportError:
            print_error("The 'cryptography' package is required for HTTPS.")
            print_error("Install dependencies with: pip install -r requirements.txt")
            return None, None

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        name = x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Beamer+"),
            x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
        ])
        # Modern browsers validate the SAN list, not the CN
        alt_names = [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        ]
        if lan_ip:
            try:
                alt_names.append(x509.IPAddress(ipaddress.ip_address(lan_ip)))
            except ValueError:
                pass

        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now)
            .not_valid_after(now + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
            .sign(key, hashes.SHA256())
        )

        # Save certificate and key
        with open(cert_file, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))

        with open(key_file, "wb") as f:
            f.write(key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            ))

        print_success("SSL certificate generated successfully")
        print_warning("Note: Browsers will show a security warning for self-signed certificates")
        print_warning("      Click 'Advanced' and 'Proceed' to continue")

        return cert_file, key_file

    except Exception as e:
        print_error(f"Failed to generate SSL certificate: {e}")
        return None, None

def check_dependencies():
    """Check and install required dependencies"""
    print_header("Checking dependencies...")
    
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
                subprocess.check_call([sys.executable, "-m", "pip", "install", "flask", "flask-socketio"])
            print_success("Flask installed successfully")
        except subprocess.CalledProcessError:
            print_error("Failed to install Flask")
            sys.exit(1)
    
    # Check Flask-SocketIO
    try:
        import flask_socketio
        print_success("Flask-SocketIO is installed")
    except ImportError:
        print_warning("Flask-SocketIO not found. Installing...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "flask-socketio"])
            print_success("Flask-SocketIO installed successfully")
        except subprocess.CalledProcessError:
            print_error("Failed to install Flask-SocketIO")
            sys.exit(1)

    # Check cryptography (needed for HTTPS cert generation)
    try:
        import cryptography
        print_success("cryptography is installed")
    except ImportError:
        print_warning("cryptography not found. Installing...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "cryptography"])
            print_success("cryptography installed successfully")
        except subprocess.CalledProcessError:
            print_error("Failed to install cryptography")
            sys.exit(1)

def display_info(lan_ip, port):
    """Display connection information"""
    print_header("Access your Beamer+ instance at:")
    print()
    
    if lan_ip:
        print(f"{Colors.BOLD}LAN IP:{Colors.ENDC}")
        print(f"  https://{lan_ip}:{port}")
    else:
        print_warning("LAN IP not detected")
    print()

def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='Launch Beamer+ Flask application',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python launch.py
  python launch.py --port 5000
  python launch.py --port 8080
        """
    )
    parser.add_argument(
        '--port',
        type=int,
        default=5000,
        help='Port to run the server on (default: 5000)'
    )
    return parser.parse_args()

def find_free_port(start_port):
    """Return start_port if free, otherwise the next available port."""
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('', port))
                return port
            except OSError:
                port += 1


def main():
    # Parse command line arguments
    args = parse_arguments()
    port = find_free_port(args.port)
    if port != args.port:
        print_warning(f"Port {args.port} is in use. Using port {port} instead.")
    
    if not os.path.exists("app.py"):
        print_error("app.py not found in current directory")
        print("Please run this script from the beamer-plus directory")
        sys.exit(1)

    check_dependencies()
    
    # Get network information (before cert generation so the LAN IP can be
    # baked into the certificate's SAN list)
    print_header("Detecting network configuration...")
    lan_ip = get_lan_ip()

    # Generate SSL certificate
    cert_file, key_file = generate_self_signed_cert(lan_ip)
    if not cert_file or not key_file:
        print_error("Failed to generate SSL certificate. Exiting.")
        sys.exit(1)
    
    # Display what was detected
    if lan_ip:
        print_success(f"LAN IP: {lan_ip}")
    else:
        print_warning("LAN IP not detected")
    
    print_success(f"Port: {port}")
    if port != args.port:
        print_warning(f"(requested port {args.port} was already in use)")
    print()
    
    # Display connection info
    display_info(lan_ip, port)
    
    # Determine primary URL for server startup messages
    primary_url = f"https://{lan_ip}:{port}" if lan_ip else f"https://127.0.0.1:{port}"
        
    # Start the Flask app
    print_header("Starting Beamer+ server with HTTPS...")
    print_warning("Your browser will show a security warning. Click 'Advanced' then 'Proceed' to continue.")
    print()
    
    try:
        # Import and run the Flask app with SocketIO
        from app import socketio, app
        print(f"{Colors.GREEN}Server is running! Press Ctrl+C to quit.{Colors.ENDC}\n")
        print(f"{Colors.BOLD}{Colors.CYAN}Presenter:{Colors.ENDC} {primary_url}")
        print()
        
        # Create SSL context
        ssl_context = (cert_file, key_file)
        
        socketio.run(app, host='0.0.0.0', port=port, debug=False, 
                    ssl_context=ssl_context, allow_unsafe_werkzeug=True)
    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}Server stopped. Goodbye!{Colors.ENDC}\n")
        sys.exit(0)
    except Exception as e:
        print_error(f"Failed to start server: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
