/*async function checkAndRequestHostPermission(origin) {
  const corePermissions = {
    origins: [origin]
  };
  if (! await browser.permissions.contains(corePermissions)) {
    return await browser.permissions.request(corePermissions);
  }
  return true;
}

checkAndRequestHostPermission('https://app.mavenlink.com/*');*/

class ResizeHelper {
  constructor(element) {
    this.element = element;
    this.animationFrameId = null;
    this.boundHandleMouseUp = this.handleMouseUp.bind(this);
    this.boundHandleMouseMove = this.handleMouseMove.bind(this);
    this.boundDoResize = this.doResize.bind(this);
  }

  handleMouseDown(event) {
    event.preventDefault();
    event.stopPropagation();

    this.clientX = event.clientX;
    this.animationFrameId = null;
    window.addEventListener('mouseup', this.boundHandleMouseUp);
    window.addEventListener('mousemove', this.boundHandleMouseMove);
  }

  handleMouseUp(event) {
    event.preventDefault();
    event.stopPropagation();

    window.removeEventListener('mousemove', this.boundHandleMouseMove);
    window.removeEventListener('mouseup', this.boundHandleMouseUp);
  }

  handleMouseMove(event) {
    event.preventDefault();
    event.stopPropagation();

    this.newClientX = event.clientX;
    if (this.animationFrameId === null) {
      this.animationFrameId = window.requestAnimationFrame(this.boundDoResize);
    }
  }

  doResize(timestamp) {
    if (isNaN(this.clientX)) {
      this.clientX = this.newClientX;
      return;
    }

    const distance = this.newClientX - this.clientX;
    let width = window.getComputedStyle(this.element).width;
    if (!width.endsWith('px')) {
      throw 'Width is not in pixels';
    }
    width = parseInt(width);
    this.element.style.setProperty('width', `${width - distance}px`);

    this.clientX = this.newClientX;
    this.animationFrameId = null;
  }
}

console.log('kantbotha.js loaded');
async function addResizeBarToSidebar() {
  await new Promise(resolve => setTimeout(resolve, 1000));
  let intervalId = setInterval(() => {
    const sidebar = document.querySelector('#side-panel');
    if (!sidebar) return;

    if (sidebar.innerHTML) {
      clearInterval(intervalId);
      const resizeBar = document.createElement('div');
      resizeBar.id = 'sidebar-resize-bar';
      sidebar.insertBefore(resizeBar, sidebar.firstElementChild);

      const resizer = new ResizeHelper(sidebar);

      resizeBar.addEventListener('mousedown', resizer.handleMouseDown.bind(resizer));
    }
  }, 100);
}

addResizeBarToSidebar();