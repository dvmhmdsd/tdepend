export interface Root {
  id: string;
}

export interface Branch extends Root {
  name: string;
}

export class Leaf implements Branch {
  id = '';
  name = '';
}
