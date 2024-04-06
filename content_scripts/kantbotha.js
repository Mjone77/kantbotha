const verbose = false;

class ResizeHelper {
  constructor(element, resizeBarElement) {
    this.element = element;
    this.resizing = false;
    this.boundHandleMouseMove = this.handleMouseMove.bind(this);
    this.boundDoAnimationFrame = this.doAnimationFrame.bind(this);

    // Use this element to block other mouse events from interfering with the resize
    this.mouseUpBlockerElement = document.createElement('div');
    this.mouseUpBlockerElement.style.setProperty('position', 'fixed');
    this.mouseUpBlockerElement.style.setProperty('top', '0');
    this.mouseUpBlockerElement.style.setProperty('left', '0');
    this.mouseUpBlockerElement.style.setProperty('width', '100vw');
    this.mouseUpBlockerElement.style.setProperty('height', '100vh');
    this.mouseUpBlockerElement.style.setProperty('z-index', `9999999999999`);
    this.mouseUpBlockerElement.style.setProperty('opacity', '0');
    this.mouseUpBlockerElement.style.setProperty('display', 'none');

    document.body.appendChild(this.mouseUpBlockerElement);

    resizeBarElement.addEventListener('mousedown', this.handleMouseDown.bind(this));
    window.addEventListener('mouseup', this.handleMouseUp.bind(this));
  }

  handleMouseDown(event) {
    if (verbose) console.log('handleMouseDown');
    event.preventDefault();
    event.stopPropagation();

    this.clientX = event.clientX;
    this.newClientX = event.clientX;
    this.resizing = true;
    this.mouseUpBlockerElement.style.setProperty('display', 'block');
    window.addEventListener('mousemove', this.boundHandleMouseMove);
    window.requestAnimationFrame(this.boundDoAnimationFrame);
  }

  handleMouseUp(event) {
    if (verbose) console.log('handleMouseUp');
    if (!this.resizing) return;

    event.preventDefault();
    event.stopPropagation();

    this.resizing = false;
    window.removeEventListener('mousemove', this.boundHandleMouseMove);
    this.clientX = null;
    this.mouseUpBlockerElement.style.setProperty('display', 'none');
  }

  handleMouseMove(event) {
    if (verbose) console.log('handleMouseMove');
    event.preventDefault();
    event.stopPropagation();

    this.newClientX = event.clientX;
  }

  doResize() {
    if (verbose) console.log('doResize');
    const newClientX = this.newClientX;
    if (this.clientX === newClientX || isNaN(newClientX)) return;
    if (isNaN(this.clientX)) {
      this.clientX = this.newClientX;
      return;
    }

    const distance = newClientX - this.clientX;
    let width = window.getComputedStyle(this.element).width;
    if (!width.endsWith('px')) {
      throw 'Width is not in pixels';
    }
    width = parseInt(width);
    if (this.resizing)
      this.element.style.setProperty('width', `${width - distance}px`);

    this.clientX = newClientX;
  }

  doAnimationFrame(timestamp) {
    if (verbose) console.log('doAnimationFrame');
    this.doResize();
    if (this.resizing)
      window.requestAnimationFrame(this.boundDoAnimationFrame);
  }
}

console.log('kantbotha.js loaded');
async function addResizeBarToSidepanel() {
  let intervalId = setInterval(() => {
    const sidepanel = document.querySelector('#side-panel');

    if (sidepanel && sidepanel.innerHTML) {
      clearInterval(intervalId);
      const resizeBar = document.createElement('div');
      resizeBar.id = 'sidepanel-resize-bar';
      sidepanel.insertBefore(resizeBar, sidepanel.firstElementChild);

      const resizer = new ResizeHelper(sidepanel, resizeBar);
      console.log('Added resize bar');
    }
  }, 100);
}

addResizeBarToSidepanel();
console.log('kantbotha.js loaded');